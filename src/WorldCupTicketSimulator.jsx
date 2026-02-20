import React, { useState, useMemo, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, AreaChart, Area } from 'recharts';

const STAGES = ['Group', 'R32', 'R16', 'QF', 'SF'];
const STAGE_LABELS = { Group: 'Group Stage', R32: 'Round of 32', R16: 'Round of 16', QF: 'Quarter-Finals', SF: 'Semi-Finals', Finals: 'Finals' };
const ALL_OUTCOMES = [...STAGES, 'RunnerUp', 'Winner'];
const OUTCOME_LABELS = { ...STAGE_LABELS, RunnerUp: 'Runner-Up', Winner: 'Winner' };

// Odds conversion helpers
const americanToDecimal = (am) => {
  if (am >= 100) return 1 + am / 100;
  if (am <= -100) return 1 + 100 / Math.abs(am);
  return 1; // invalid
};
const decimalToAmerican = (dec) => {
  if (dec >= 2) return Math.round((dec - 1) * 100);
  if (dec > 1) return Math.round(-100 / (dec - 1));
  return 0;
};

const STORAGE_KEY = 'wc-ticket-sim-state';

const DEFAULTS = {
  pricePerTicket: 4185, numTickets: 2,
  resaleFeePercent: 15, processingFeePercent: 3, fixedTransactionCost: 0,
  annualOpportunityCost: 6, expectedResale: 10000,
  hedgeEnabled: true,
  bettingOdds: { Group: 31, R32: 4.3, R16: 4.0, QF: 4.3, SF: 5.5, RunnerUp: 9.0, Winner: 9.0 },
  oddsFormat: 'decimal',
  hedgeStakes: { Group: 25, R32: 300, R16: 500, QF: 1200, SF: 3100 },
};

const loadState = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch { return DEFAULTS; }
};

const WorldCupTicketSimulator = () => {
  const [saved] = useState(loadState);

  // Core Purchase Inputs
  const [pricePerTicket, setPricePerTicket] = useState(saved.pricePerTicket);
  const [numTickets, setNumTickets] = useState(saved.numTickets);

  // Transaction Costs
  const [resaleFeePercent, setResaleFeePercent] = useState(saved.resaleFeePercent);
  const [processingFeePercent, setProcessingFeePercent] = useState(saved.processingFeePercent);
  const [fixedTransactionCost, setFixedTransactionCost] = useState(saved.fixedTransactionCost);

  // Carrying Cost
  const [annualOpportunityCost, setAnnualOpportunityCost] = useState(saved.annualOpportunityCost);

  // Selling Price Assumptions
  const [expectedResale, setExpectedResale] = useState(saved.expectedResale);

  // Hedge Inputs
  const [hedgeEnabled, setHedgeEnabled] = useState(saved.hedgeEnabled);
  const [bettingOdds, setBettingOdds] = useState(saved.bettingOdds);
  const [oddsFormat, setOddsFormat] = useState(saved.oddsFormat);
  const [hedgeStakes, setHedgeStakes] = useState(saved.hedgeStakes);

  // Investor Stake
  const [investorStakePercent, setInvestorStakePercent] = useState(100);

  // Persist all inputs to localStorage on change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      pricePerTicket, numTickets, resaleFeePercent, processingFeePercent, fixedTransactionCost,
      annualOpportunityCost, expectedResale, hedgeEnabled, bettingOdds, oddsFormat, hedgeStakes,
    }));
  }, [pricePerTicket, numTickets, resaleFeePercent, processingFeePercent, fixedTransactionCost,
      annualOpportunityCost, expectedResale, hedgeEnabled, bettingOdds, oddsFormat, hedgeStakes]);

  // Timing: when each hedge is placed and when proceeds are received
  const hedgeMonths = { Group: 4, R32: 4, R16: 4, QF: 5, SF: 5 };
  const proceedsMonth = 5.5;

  // Derived probabilities from betting odds
  const oddsData = useMemo(() => {
    const impliedProbs = {};
    let totalImplied = 0;
    for (const key of ALL_OUTCOMES) {
      const ip = bettingOdds[key] > 0 ? (1 / bettingOdds[key]) * 100 : 0;
      impliedProbs[key] = ip;
      totalImplied += ip;
    }
    const margin = totalImplied - 100;
    const fairProbs = {};
    for (const key of ALL_OUTCOMES) {
      fairProbs[key] = totalImplied > 0 ? (impliedProbs[key] / totalImplied) * 100 : 0;
    }
    return { impliedProbs, totalImplied, margin, fairProbs };
  }, [bettingOdds]);

  // Derived elimination probabilities (fair, rescaled)
  const elimProbs = useMemo(() => {
    const ep = {};
    for (const s of STAGES) ep[s] = oddsData.fairProbs[s];
    return ep;
  }, [oddsData]);

  // Conditional probabilities and adjusted odds per stage
  // As Brazil advances, past stages are certain → conditional odds for later bets
  const stageOdds = useMemo(() => {
    const data = {};
    const vigFactor = oddsData.totalImplied > 0 ? 100 / oddsData.totalImplied : 1; // <1 when margin exists
    let cumProb = 0;
    for (const stage of STAGES) {
      const survivalProb = (100 - cumProb) / 100;
      const condProb = survivalProb > 0 ? (elimProbs[stage] / 100) / survivalProb : 0;
      const fairOdds = condProb > 0 ? 1 / condProb : Infinity;
      const adjustedOdds = fairOdds * vigFactor; // apply bookmaker margin
      data[stage] = { condProb, fairOdds, adjustedOdds };
      cumProb += elimProbs[stage];
    }
    return data;
  }, [elimProbs, oddsData]);

  // Calculated values
  const totalPurchase = numTickets * pricePerTicket;
  const carryingCost = totalPurchase * ((1 + annualOpportunityCost / 100) ** (proceedsMonth / 12) - 1);
  const probFinals = oddsData.fairProbs.RunnerUp + oddsData.fairProbs.Winner;

  // IRR solver
  const calculateIRR = (cashFlows, maxIter = 100, tol = 1e-8) => {
    const npv = (r) => cashFlows.reduce((sum, cf) => sum + cf.amount / (1 + r) ** cf.month, 0);
    const dnpv = (r) => cashFlows.reduce((sum, cf) => sum + (-cf.month * cf.amount) / (1 + r) ** (cf.month + 1), 0);
    let r = 0.01;
    for (let i = 0; i < maxIter; i++) {
      const f = npv(r);
      const df = dnpv(r);
      if (Math.abs(df) < 1e-14) break;
      const rNew = r - f / df;
      if (Math.abs(rNew - r) < tol) { r = rNew; break; }
      r = rNew;
      if (r <= -1) return -100;
    }
    return ((1 + r) ** 12 - 1) * 100;
  };

  // Carrying cost for hedge stakes, weighted by per-stage timing
  const hedgeCarryCostPerStage = (stages) => {
    if (!hedgeEnabled) return 0;
    return stages.reduce((sum, s) => {
      const carryPeriod = proceedsMonth - hedgeMonths[s];
      return sum + hedgeStakes[s] * ((1 + annualOpportunityCost / 100) ** (carryPeriod / 12) - 1);
    }, 0);
  };

  // Build all 6 scenarios
  const scenarios = useMemo(() => {
    const results = [];

    // 5 elimination scenarios
    for (let i = 0; i < STAGES.length; i++) {
      const elimStage = STAGES[i];
      const placedStages = STAGES.slice(0, i + 1);
      const totalStakePlaced = hedgeEnabled ? placedStages.reduce((sum, s) => sum + hedgeStakes[s], 0) : 0;
      const hCarryCost = hedgeCarryCostPerStage(placedStages);

      // Winning hedge: use conditional odds (adjusted for margin)
      const winningStake = hedgeEnabled ? hedgeStakes[elimStage] : 0;
      const winningOdds = stageOdds[elimStage].adjustedOdds;
      const hedgeReturn = winningStake * winningOdds;

      const lostStakes = hedgeEnabled ? STAGES.slice(0, i).reduce((sum, s) => sum + hedgeStakes[s], 0) : 0;
      const hedgeResult = hedgeEnabled ? (winningStake * (winningOdds - 1) - lostStakes) : 0;

      // Reimbursement (no fees)
      const grossProceeds = pricePerTicket * numTickets;
      const netPL = grossProceeds - totalPurchase - carryingCost - hCarryCost + hedgeResult;

      // IRR cash flows (hedge outflows grouped by month)
      const cashFlows = [
        { month: 0, amount: -totalPurchase },
        { month: proceedsMonth, amount: grossProceeds + (hedgeEnabled ? hedgeReturn : 0) }
      ];
      if (hedgeEnabled) {
        const outflowByMonth = {};
        for (const s of placedStages) {
          const m = hedgeMonths[s];
          outflowByMonth[m] = (outflowByMonth[m] || 0) + hedgeStakes[s];
        }
        for (const [m, amt] of Object.entries(outflowByMonth)) {
          cashFlows.push({ month: Number(m), amount: -amt });
        }
      }

      results.push({
        stage: elimStage,
        label: `Eliminated: ${STAGE_LABELS[elimStage]}`,
        probability: elimProbs[elimStage],
        isFinals: false,
        grossProceeds,
        netProceeds: grossProceeds,
        resaleFee: 0,
        processingFee: 0,
        totalFees: 0,
        hedgeResult,
        hCarryCost,
        totalStakePlaced,
        placedStages,
        netPL,
        roi: calculateIRR(cashFlows)
      });
    }

    // Finals scenario: all hedges placed and lost
    const allStakes = hedgeEnabled ? STAGES.reduce((sum, s) => sum + hedgeStakes[s], 0) : 0;
    const hCarryCostFinals = hedgeCarryCostPerStage(STAGES);
    const hedgeResultFinals = hedgeEnabled ? -allStakes : 0;

    const grossProceeds = expectedResale * numTickets;
    const resaleFee = grossProceeds * (resaleFeePercent / 100);
    const processingFee = grossProceeds * (processingFeePercent / 100);
    const totalFees = resaleFee + processingFee + fixedTransactionCost;
    const netProceeds = grossProceeds - totalFees;
    const netPLFinals = netProceeds - totalPurchase - carryingCost - hCarryCostFinals + hedgeResultFinals;

    const cashFlowsFinals = [
      { month: 0, amount: -totalPurchase },
      { month: proceedsMonth, amount: netProceeds }
    ];
    if (hedgeEnabled) {
      const outflowByMonth = {};
      for (const s of STAGES) {
        const m = hedgeMonths[s];
        outflowByMonth[m] = (outflowByMonth[m] || 0) + hedgeStakes[s];
      }
      for (const [m, amt] of Object.entries(outflowByMonth)) {
        cashFlowsFinals.push({ month: Number(m), amount: -amt });
      }
    }

    results.push({
      stage: 'Finals',
      label: 'Brazil Reaches Finals',
      probability: probFinals,
      isFinals: true,
      grossProceeds,
      netProceeds,
      resaleFee,
      processingFee,
      totalFees,
      hedgeResult: hedgeResultFinals,
      hCarryCost: hCarryCostFinals,
      totalStakePlaced: allStakes,
      placedStages: STAGES,
      netPL: netPLFinals,
      roi: calculateIRR(cashFlowsFinals)
    });

    return results;
  }, [elimProbs, hedgeStakes, hedgeEnabled, stageOdds, pricePerTicket, numTickets, expectedResale,
      resaleFeePercent, processingFeePercent, fixedTransactionCost, totalPurchase, carryingCost,
      annualOpportunityCost, probFinals]);

  // Expected Value & IRR
  const expectedValue = scenarios.reduce((sum, s) => sum + (s.probability / 100) * s.netPL, 0);
  const expectedROI = useMemo(() => {
    let weightedEndInflow = 0;
    const weightedOutflowByMonth = {};
    for (const s of scenarios) {
      const p = s.probability / 100;
      if (s.isFinals) {
        weightedEndInflow += p * s.netProceeds;
      } else {
        const winStake = hedgeEnabled ? hedgeStakes[s.stage] : 0;
        const winOdds = stageOdds[s.stage]?.adjustedOdds || 0;
        weightedEndInflow += p * (s.grossProceeds + (hedgeEnabled ? winStake * winOdds : 0));
      }
      if (hedgeEnabled) {
        for (const st of s.placedStages) {
          const m = hedgeMonths[st];
          weightedOutflowByMonth[m] = (weightedOutflowByMonth[m] || 0) + p * hedgeStakes[st];
        }
      }
    }
    const cashFlows = [
      { month: 0, amount: -totalPurchase },
      { month: proceedsMonth, amount: weightedEndInflow }
    ];
    for (const [m, amt] of Object.entries(weightedOutflowByMonth)) {
      cashFlows.push({ month: Number(m), amount: -amt });
    }
    return calculateIRR(cashFlows);
  }, [scenarios, totalPurchase, hedgeEnabled, hedgeStakes, stageOdds]);

  // Breakeven: resale price in finals scenario where netPL = 0
  const finalsScenario = scenarios.find(s => s.isFinals);
  const breakEvenResale = useMemo(() => {
    const netFeeRate = 1 - (resaleFeePercent / 100) - (processingFeePercent / 100);
    const allStakes = hedgeEnabled ? STAGES.reduce((sum, s) => sum + hedgeStakes[s], 0) : 0;
    const hcc = hedgeCarryCostPerStage(STAGES);
    const hedgeRes = hedgeEnabled ? -allStakes : 0;
    const targetNet = totalPurchase + carryingCost + hcc - hedgeRes;
    return (targetNet + fixedTransactionCost) / (numTickets * netFeeRate);
  }, [totalPurchase, carryingCost, numTickets, resaleFeePercent, processingFeePercent, fixedTransactionCost,
      hedgeEnabled, hedgeStakes, annualOpportunityCost]);

  // Sensitivity: Finals P&L vs resale price
  const sensitivityData = useMemo(() => {
    const data = [];
    const elimPL = scenarios.filter(s => !s.isFinals).reduce((sum, s) => sum + (s.probability / 100) * s.netPL, 0);
    const pFinals = probFinals / 100;
    const allStakes = hedgeEnabled ? STAGES.reduce((sum, s) => sum + hedgeStakes[s], 0) : 0;
    const hcc = hedgeCarryCostPerStage(STAGES);
    const hedgeRes = hedgeEnabled ? -allStakes : 0;
    const netFeeRate = 1 - (resaleFeePercent / 100) - (processingFeePercent / 100);

    for (let price = 2000; price <= 30000; price += 500) {
      const gross = price * numTickets;
      const np = gross * netFeeRate - fixedTransactionCost;
      const finalsPL = np - totalPurchase - carryingCost - hcc + hedgeRes;
      const ev = pFinals * finalsPL + elimPL;
      data.push({ price, finals: finalsPL, expectedValue: ev });
    }
    return data;
  }, [scenarios, probFinals, numTickets, resaleFeePercent, processingFeePercent, fixedTransactionCost,
      totalPurchase, carryingCost, hedgeEnabled, hedgeStakes, annualOpportunityCost]);

  // Risk Metrics
  const maxLoss = Math.min(...scenarios.map(s => s.netPL));
  const maxGain = Math.max(...scenarios.map(s => s.netPL));

  const formatCurrency = (value) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
  const formatPercent = (value) => `${value.toFixed(2)}%`;

  const updateOdds = (key, displayValue) => {
    const val = Number(displayValue);
    const decOdds = oddsFormat === 'american' ? americanToDecimal(val) : val;
    if (decOdds > 1) setBettingOdds(prev => ({ ...prev, [key]: decOdds }));
  };
  const getDisplayOdds = (key) => {
    const dec = bettingOdds[key];
    if (oddsFormat === 'american') return decimalToAmerican(dec);
    return dec;
  };
  const updateHedgeStake = (stage, value) => setHedgeStakes(prev => ({ ...prev, [stage]: Number(value) }));

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="bg-white rounded-xl shadow-2xl p-8 mb-8">
          <h1 className="text-4xl font-bold text-indigo-900 mb-2">World Cup Ticket Investment Simulator</h1>
          <p className="text-gray-600 mb-6">Model the profit/loss of buying FIFA World Cup Final tickets across 6 scenarios</p>

          {/* Dashboard Summary */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div className="bg-gradient-to-br from-blue-500 to-blue-600 rounded-lg p-6 text-white">
              <div className="text-sm opacity-90 mb-1">Expected Value</div>
              <div className="text-3xl font-bold">{formatCurrency(expectedValue * (investorStakePercent / 100))}</div>
              <div className="text-sm mt-2 opacity-90">IRR: {formatPercent(expectedROI)}</div>
            </div>
            <div className={`${finalsScenario.netPL >= 0 ? 'bg-gradient-to-br from-green-500 to-green-600' : 'bg-gradient-to-br from-red-500 to-red-600'} rounded-lg p-6 text-white`}>
              <div className="text-sm opacity-90 mb-1">Finals ({probFinals.toFixed(1)}%)</div>
              <div className="text-3xl font-bold">{formatCurrency(finalsScenario.netPL * (investorStakePercent / 100))}</div>
              <div className="text-sm mt-2 opacity-90">IRR: {formatPercent(finalsScenario.roi)}</div>
            </div>
            <div className="bg-gradient-to-br from-purple-500 to-purple-600 rounded-lg p-6 text-white">
              <div className="text-sm opacity-90 mb-1">Breakeven Resale</div>
              <div className="text-3xl font-bold">{formatCurrency(breakEvenResale)}</div>
              <div className="text-sm mt-2 opacity-90">per ticket</div>
            </div>
            <div className="bg-gradient-to-br from-gray-600 to-gray-700 rounded-lg p-6 text-white">
              <div className="text-sm opacity-90 mb-1">Risk Range</div>
              <div className="text-lg font-bold">{formatCurrency(maxLoss * (investorStakePercent / 100))}</div>
              <div className="text-lg font-bold">to {formatCurrency(maxGain * (investorStakePercent / 100))}</div>
            </div>
          </div>

          {/* Investor Stake Input */}
          <div className="bg-indigo-50 rounded-lg p-6 mb-8 border-2 border-indigo-200">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Investor Stake (%)</label>
              <input type="number" step="0.01" min="0" max="100" value={investorStakePercent} onChange={(e) => setInvestorStakePercent(Math.min(Math.max(Number(e.target.value), 0), 100))} className="w-32 px-4 py-2 border border-indigo-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
              <p className="text-sm text-gray-600 mt-2">Your proportional share of the investment strategy results</p>
            </div>
          </div>

          {/* Hedge Module */}
          <div className="bg-gradient-to-r from-amber-50 to-orange-50 rounded-lg p-6 mb-8 border-2 border-amber-200">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold text-gray-800">Hedge Module (Stage-by-Stage Bets Against Brazil)</h3>
              <label className="flex items-center cursor-pointer">
                <div className="relative">
                  <input type="checkbox" checked={hedgeEnabled} onChange={(e) => setHedgeEnabled(e.target.checked)} className="sr-only" />
                  <div className={`block w-14 h-8 rounded-full ${hedgeEnabled ? 'bg-green-500' : 'bg-gray-300'}`}></div>
                  <div className={`dot absolute left-1 top-1 bg-white w-6 h-6 rounded-full transition ${hedgeEnabled ? 'transform translate-x-6' : ''}`}></div>
                </div>
                <span className="ml-3 text-sm font-medium text-gray-700">{hedgeEnabled ? 'Enabled' : 'Disabled'}</span>
              </label>
            </div>

            {hedgeEnabled && (
              <div className="space-y-4">
                {/* Summary cards */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-2">
                  {/* Odds format toggle */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Odds Format</label>
                    <div className="flex rounded-lg overflow-hidden border border-gray-300">
                      <button
                        onClick={() => setOddsFormat('decimal')}
                        className={`flex-1 px-3 py-2 text-sm font-medium ${oddsFormat === 'decimal' ? 'bg-amber-500 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                      >Decimal</button>
                      <button
                        onClick={() => setOddsFormat('american')}
                        className={`flex-1 px-3 py-2 text-sm font-medium ${oddsFormat === 'american' ? 'bg-amber-500 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                      >American</button>
                    </div>
                  </div>
                  <div className="bg-white rounded p-4">
                    <div className="text-xs text-gray-600 mb-1">Bookmaker Margin</div>
                    <div className={`text-lg font-bold ${oddsData.margin > 0 ? 'text-red-600' : 'text-green-600'}`}>{oddsData.margin.toFixed(1)}%</div>
                  </div>
                  <div className="bg-white rounded p-4">
                    <div className="text-xs text-gray-600 mb-1">P(Brazil Reaches Finals)</div>
                    <div className={`text-lg font-bold ${probFinals >= 0 ? 'text-indigo-600' : 'text-red-600'}`}>{probFinals.toFixed(1)}%</div>
                  </div>
                  <div className="bg-white rounded p-4">
                    <div className="text-xs text-gray-600 mb-1">Hedge Timing</div>
                    <div className="text-sm font-bold text-gray-800">Group/R32/R16: Mo {hedgeMonths.Group}</div>
                    <div className="text-sm font-bold text-gray-800">QF/SF: Mo {hedgeMonths.QF} | Sale: Mo {proceedsMonth}</div>
                  </div>
                </div>

                {/* Per-outcome odds table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b-2 border-amber-300">
                        <th className="text-left py-2 px-2 font-semibold text-gray-700">Outcome</th>
                        <th className="text-right py-2 px-2 font-semibold text-gray-700">Odds ({oddsFormat === 'decimal' ? 'Dec' : 'US'})</th>
                        <th className="text-right py-2 px-2 font-semibold text-gray-700">Fair P%</th>
                        <th className="text-right py-2 px-2 font-semibold text-gray-700">Cond. Odds</th>
                        <th className="text-right py-2 px-2 font-semibold text-gray-700">Stake ($)</th>
                        <th className="text-right py-2 px-2 font-semibold text-gray-700">Payout</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ALL_OUTCOMES.map(key => {
                        const isHedgeable = STAGES.includes(key);
                        const isFinalsGroup = key === 'RunnerUp' || key === 'Winner';
                        return (
                          <tr key={key} className={`border-b border-amber-100 ${isFinalsGroup ? 'bg-green-50' : ''}`}>
                            <td className="py-2 px-2 font-medium">{OUTCOME_LABELS[key]}</td>
                            <td className="py-2 px-2">
                              <input
                                type="number"
                                step={oddsFormat === 'decimal' ? '0.01' : '1'}
                                value={getDisplayOdds(key)}
                                onChange={(e) => updateOdds(key, e.target.value)}
                                className="w-24 px-2 py-1 border border-gray-300 rounded text-right focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                              />
                            </td>
                            <td className="py-2 px-2 text-right text-gray-600">{oddsData.fairProbs[key].toFixed(1)}%</td>
                            <td className="py-2 px-2 text-right font-semibold text-amber-700">
                              {isHedgeable ? (stageOdds[key].adjustedOdds === Infinity ? '-' : stageOdds[key].adjustedOdds.toFixed(2)) : '-'}
                            </td>
                            <td className="py-2 px-2">
                              {isHedgeable ? (
                                <input type="number" step={key === 'Group' || key === 'R32' ? '10' : '100'} value={hedgeStakes[key]} onChange={(e) => updateHedgeStake(key, e.target.value)} className="w-24 px-2 py-1 border border-gray-300 rounded text-right focus:ring-2 focus:ring-amber-500 focus:border-transparent" />
                              ) : (
                                <span className="text-gray-400 text-right block">-</span>
                              )}
                            </td>
                            <td className="py-2 px-2 text-right font-semibold text-green-600">
                              {isHedgeable ? formatCurrency(hedgeStakes[key] * (stageOdds[key].adjustedOdds - 1)) : '-'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-amber-300 font-bold">
                        <td className="py-2 px-2">Total</td>
                        <td></td>
                        <td className="py-2 px-2 text-right">100.0%</td>
                        <td></td>
                        <td className="py-2 px-2 text-right">{formatCurrency(STAGES.reduce((s, st) => s + hedgeStakes[st], 0))}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* 6-Scenario P&L Table */}
          <div className="mb-8">
            <h3 className="text-xl font-bold text-gray-800 mb-4">Scenario Analysis (6 Outcomes)</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-100">
                    <th className="text-left py-3 px-3 font-semibold">Scenario</th>
                    <th className="text-right py-3 px-3 font-semibold">Prob</th>
                    <th className="text-right py-3 px-3 font-semibold">Proceeds</th>
                    <th className="text-right py-3 px-3 font-semibold">Fees</th>
                    <th className="text-right py-3 px-3 font-semibold">Hedge Result</th>
                    <th className="text-right py-3 px-3 font-semibold">Hedge Carry</th>
                    <th className="text-right py-3 px-3 font-semibold">Carry Cost</th>
                    <th className="text-right py-3 px-3 font-semibold">Net P&L</th>
                    <th className="text-right py-3 px-3 font-semibold">IRR</th>
                  </tr>
                </thead>
                <tbody>
                  {scenarios.map(s => (
                    <tr key={s.stage} className={`border-b ${s.isFinals ? 'bg-green-50 font-semibold' : ''}`}>
                      <td className="py-3 px-3">
                        <span className={s.isFinals ? 'text-green-700' : 'text-red-700'}>{s.isFinals ? '✅' : '❌'}</span>{' '}
                        {s.isFinals ? 'Brazil Reaches Finals' : `Elim: ${STAGE_LABELS[s.stage]}`}
                      </td>
                      <td className="py-3 px-3 text-right">{s.probability.toFixed(1)}%</td>
                      <td className="py-3 px-3 text-right">{formatCurrency(s.grossProceeds)}</td>
                      <td className="py-3 px-3 text-right text-red-600">{s.totalFees > 0 ? `-${formatCurrency(s.totalFees)}` : '-'}</td>
                      <td className={`py-3 px-3 text-right font-semibold ${s.hedgeResult >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {hedgeEnabled ? formatCurrency(s.hedgeResult) : '-'}
                      </td>
                      <td className="py-3 px-3 text-right text-red-600">{hedgeEnabled && s.hCarryCost > 0 ? `-${formatCurrency(s.hCarryCost)}` : '-'}</td>
                      <td className="py-3 px-3 text-right text-red-600">-{formatCurrency(carryingCost)}</td>
                      <td className={`py-3 px-3 text-right font-bold text-lg ${s.netPL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {formatCurrency(s.netPL)}
                      </td>
                      <td className={`py-3 px-3 text-right font-semibold ${s.roi >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {formatPercent(s.roi)}
                      </td>
                    </tr>
                  ))}
                  {/* Expected row */}
                  <tr className="bg-blue-50 font-bold border-t-2 border-blue-300">
                    <td className="py-3 px-3">Expected (Probability-Weighted)</td>
                    <td className="py-3 px-3 text-right">100%</td>
                    <td colSpan={5}></td>
                    <td className={`py-3 px-3 text-right text-lg ${expectedValue >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {formatCurrency(expectedValue)}
                    </td>
                    <td className={`py-3 px-3 text-right ${expectedROI >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {formatPercent(expectedROI)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Sensitivity Analysis - Resale Price (Finals only) */}
          <div className="bg-white rounded-lg p-6 mb-8 border border-gray-200">
            <h3 className="text-xl font-bold text-gray-800 mb-4">Sensitivity: Finals Resale Price</h3>
            <ResponsiveContainer width="100%" height={400}>
              <LineChart data={sensitivityData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="price" label={{ value: 'Resale Price per Ticket ($)', position: 'insideBottom', offset: -5 }} tickFormatter={(v) => `$${v/1000}k`} />
                <YAxis label={{ value: 'Net P&L ($)', angle: -90, position: 'insideLeft' }} tickFormatter={(v) => `$${v/1000}k`} />
                <Tooltip formatter={(v) => formatCurrency(v)} labelFormatter={(v) => `Price: ${formatCurrency(v)}`} />
                <Legend />
                <Line type="monotone" dataKey="finals" stroke="#10b981" strokeWidth={2} name="Finals P&L" dot={false} />
                <Line type="monotone" dataKey="expectedValue" stroke="#6366f1" strokeWidth={3} name="Expected Value" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Input Sections - Moved to Bottom */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            {/* Purchase Variables */}
            <div className="bg-gray-50 rounded-lg p-6">
              <h3 className="text-xl font-bold text-gray-800 mb-4">Ticket Purchase</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Purchase Price per Ticket</label>
                  <input type="number" value={pricePerTicket} onChange={(e) => setPricePerTicket(Number(e.target.value))} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Number of Tickets</label>
                  <input type="number" value={numTickets} onChange={(e) => setNumTickets(Number(e.target.value))} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
                </div>
                <div className="pt-2 border-t border-gray-300">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium text-gray-700">Total Upfront Cost:</span>
                    <span className="text-xl font-bold text-indigo-600">{formatCurrency(totalPurchase)}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Transaction Costs */}
            <div className="bg-gray-50 rounded-lg p-6">
              <h3 className="text-xl font-bold text-gray-800 mb-4">Transaction Costs</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">FIFA Resale Fee (%)</label>
                  <input type="number" step="0.1" value={resaleFeePercent} onChange={(e) => setResaleFeePercent(Number(e.target.value))} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Payment Processing Fee (%)</label>
                  <input type="number" step="0.1" value={processingFeePercent} onChange={(e) => setProcessingFeePercent(Number(e.target.value))} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Fixed Transaction Cost ($)</label>
                  <input type="number" value={fixedTransactionCost} onChange={(e) => setFixedTransactionCost(Number(e.target.value))} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
                </div>
              </div>
            </div>

            {/* Carrying Cost */}
            <div className="bg-gray-50 rounded-lg p-6">
              <h3 className="text-xl font-bold text-gray-800 mb-4">Carrying / Opportunity Cost</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Annual Opportunity Cost Rate (%)</label>
                  <input type="number" step="0.1" value={annualOpportunityCost} onChange={(e) => setAnnualOpportunityCost(Number(e.target.value))} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Proceeds Month</label>
                  <div className="w-full px-4 py-2 bg-gray-100 border border-gray-300 rounded-lg text-gray-700">{proceedsMonth}</div>
                </div>
                <div className="pt-2 border-t border-gray-300">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium text-gray-700">Total Carrying Cost:</span>
                    <span className="text-xl font-bold text-orange-600">{formatCurrency(carryingCost)}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Selling Prices */}
            <div className="bg-gray-50 rounded-lg p-6">
              <h3 className="text-xl font-bold text-gray-800 mb-4">Resale Price Assumptions</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Expected Resale per Ticket (if Finals)</label>
                  <input type="number" value={expectedResale} onChange={(e) => setExpectedResale(Number(e.target.value))} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
                </div>
                <div className="pt-2 border-t border-gray-300 text-sm text-gray-500">
                  If Brazil is eliminated at any stage: full reimbursement at {formatCurrency(pricePerTicket)}/ticket (no fees).
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center text-gray-600 text-sm">
          <p>All calculations assume no taxes. IRR computed via Newton-Raphson on actual cash flows.</p>
          <p className="mt-2">EV = sum of P(scenario) x Net P&L(scenario) across all 6 outcomes.</p>
        </div>
      </div>
    </div>
  );
};

export default WorldCupTicketSimulator;

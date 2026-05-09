/**
 * Create and run the two Phase 3 Combo Bot baseline simulations.
 *
 * Usage:
 *   ./node_modules/.bin/tsx scripts/runPhase3Baseline.ts
 *
 * Clones the original loss-bearing run's persisted config into two fresh
 * simulations, changing only comboGridLevels (10 vs 20), then runs each
 * simulation synchronously through the normal DB-backed engine path.
 */

import prisma from '../src/lib/prisma';
import { runSimulation } from '../src/lib/simulation/engine';

const SOURCE_SIMULATION_ID = 'cmovvwc8j07k3ickqjws9jjn4';

async function cloneBaselineRun(gridLevels: number, label: string): Promise<string> {
  const source = await prisma.simulation.findUnique({
    where: { id: SOURCE_SIMULATION_ID },
    include: {
      gridConfigs: true,
      comboConfigs: true,
    },
  });

  if (!source) {
    throw new Error(`Source simulation not found: ${SOURCE_SIMULATION_ID}`);
  }
  if (!source.comboBotEnabled) {
    throw new Error(`Source simulation is not a combo run: ${SOURCE_SIMULATION_ID}`);
  }

  const created = await prisma.simulation.create({
    data: {
      name: label,
      pair: source.pair,
      poolAddress: source.poolAddress,
      chain: source.chain,
      startTime: source.startTime,
      endTime: source.endTime,
      timeframe: source.timeframe,
      feeRate: source.feeRate,
      adaptiveEnabled: source.adaptiveEnabled,
      emaPeriod: source.emaPeriod,
      volumeMultiplier: source.volumeMultiplier,
      comboBotEnabled: true,
      comboMode: source.comboMode,
      comboLeverage: source.comboLeverage,
      comboAllocationLong: source.comboAllocationLong,
      comboAvwapEnabled: source.comboAvwapEnabled,
      comboGridLevels: gridLevels,
      requireDirectionalConfirmation: false,
      gridConfigs: {
        create: source.gridConfigs.map(config => ({
          side: config.side,
          gridLevels: config.gridLevels,
          gridType: config.gridType,
          upperBound: config.upperBound,
          lowerBound: config.lowerBound,
          orderSizeType: config.orderSizeType,
          orderSize: config.orderSize,
          totalCapital: config.totalCapital,
          profitMode: config.profitMode,
          customProfitDistance: config.customProfitDistance,
        })),
      },
      comboConfigs: {
        create: source.comboConfigs.map(config => ({
          side: config.side,
          averagingDepth: config.averagingDepth,
          slBasePercent: config.slBasePercent,
          slAtrMultiplier: config.slAtrMultiplier,
          slFloor: config.slFloor,
          slCap: config.slCap,
          tier1Size: config.tier1Size,
          tier2Size: config.tier2Size,
          tier3Size: config.tier3Size,
          cooldownCandles: config.cooldownCandles,
          retryCap: config.retryCap,
          hibernationCandles: config.hibernationCandles,
        })),
      },
    },
  });

  process.stdout.write(`Created ${label}: ${created.id}\n`);
  await runSimulation(created.id);
  process.stdout.write(`Completed ${label}: ${created.id}\n`);
  return created.id;
}

async function main(): Promise<void> {
  const runAId = await cloneBaselineRun(10, 'Phase 3 Baseline A - GL10');
  const runBId = await cloneBaselineRun(20, 'Phase 3 Baseline B - GL20');

  process.stdout.write(`\nRun A: ${runAId}\nRun B: ${runBId}\n`);
}

main()
  .catch(error => {
    process.stderr.write(`Phase 3 baseline failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

// Random parameter search for optimizer

export interface ParamRange {
  name: string;
  type: 'continuous' | 'discrete' | 'choice';
  min?: number;
  max?: number;
  step?: number;     // for discrete
  choices?: any[];   // for choice type
}

export interface SearchConfig {
  paramRanges: ParamRange[];
  iterations: number;  // number of random samples
  seed?: number;       // for reproducibility
}

export function generateRandomParams(ranges: ParamRange[]): Record<string, any> {
  const params: Record<string, any> = {};

  for (const range of ranges) {
    switch (range.type) {
      case 'continuous':
        params[range.name] = range.min! + Math.random() * (range.max! - range.min!);
        break;
      case 'discrete': {
        const step = range.step || 1;
        const steps = Math.floor((range.max! - range.min!) / step);
        params[range.name] = range.min! + Math.floor(Math.random() * (steps + 1)) * step;
        break;
      }
      case 'choice':
        params[range.name] = range.choices![Math.floor(Math.random() * range.choices!.length)];
        break;
    }
  }

  return params;
}

export function generateSearchSpace(config: SearchConfig): Record<string, any>[] {
  const results: Record<string, any>[] = [];
  for (let i = 0; i < config.iterations; i++) {
    results.push(generateRandomParams(config.paramRanges));
  }
  return results;
}

// Default DCA parameter ranges for optimization
export const DCA_PARAM_RANGES: ParamRange[] = [
  { name: 'baseOrderSize', type: 'discrete', min: 50, max: 500, step: 50 },
  { name: 'deviationFirstOrder', type: 'continuous', min: 0.5, max: 5.0 },
  { name: 'deviationStepMultiplier', type: 'continuous', min: 1.0, max: 3.0 },
  { name: 'averagingOrderSize', type: 'discrete', min: 50, max: 500, step: 50 },
  { name: 'orderSizeMultiplier', type: 'continuous', min: 1.0, max: 2.5 },
  { name: 'maxAveragingOrders', type: 'discrete', min: 1, max: 10, step: 1 },
  { name: 'takeProfitPercent', type: 'continuous', min: 0.5, max: 10.0 },
  { name: 'trailingPercent', type: 'continuous', min: 0.1, max: 3.0 },
  { name: 'stopLossPercent', type: 'continuous', min: 1.0, max: 20.0 },
];

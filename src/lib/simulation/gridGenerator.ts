// Grid level generation — arithmetic and geometric spacing

import { GridLevel, GridSide, GridType } from '../types';

export function generateGridLevels(
  lowerBound: number,
  upperBound: number,
  levels: number,
  side: GridSide,
  gridType: GridType
): GridLevel[] {
  if (levels < 2) {
    return [{ index: 0, price: lowerBound, side }];
  }

  if (gridType === 'geometric') {
    return generateGeometricGrid(lowerBound, upperBound, levels, side);
  }
  return generateArithmeticGrid(lowerBound, upperBound, levels, side);
}

function generateArithmeticGrid(
  lowerBound: number,
  upperBound: number,
  levels: number,
  side: GridSide
): GridLevel[] {
  const spacing = (upperBound - lowerBound) / (levels - 1);
  return Array.from({ length: levels }, (_, i) => ({
    index: i,
    price: Number((lowerBound + i * spacing).toFixed(8)),
    side,
  }));
}

function generateGeometricGrid(
  lowerBound: number,
  upperBound: number,
  levels: number,
  side: GridSide
): GridLevel[] {
  const ratio = Math.pow(upperBound / lowerBound, 1 / (levels - 1));
  return Array.from({ length: levels }, (_, i) => ({
    index: i,
    price: Number((lowerBound * Math.pow(ratio, i)).toFixed(8)),
    side,
  }));
}

// Calculate grid spacing info for display
export function getGridSpacing(
  lowerBound: number,
  upperBound: number,
  levels: number,
  gridType: GridType
): { spacing: number; spacingPct: number } {
  if (levels < 2) return { spacing: 0, spacingPct: 0 };

  if (gridType === 'arithmetic') {
    const spacing = (upperBound - lowerBound) / (levels - 1);
    const spacingPct = (spacing / lowerBound) * 100;
    return { spacing, spacingPct };
  }

  // Geometric
  const ratio = Math.pow(upperBound / lowerBound, 1 / (levels - 1));
  const spacingPct = (ratio - 1) * 100;
  const spacing = lowerBound * (ratio - 1); // Spacing at lowest level
  return { spacing, spacingPct };
}

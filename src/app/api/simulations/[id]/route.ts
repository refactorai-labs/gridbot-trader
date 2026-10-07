import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

// GET: Full simulation detail
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const simulation = await prisma.simulation.findUnique({
      where: { id: params.id },
      include: {
        gridConfigs: true,
      },
    });

    if (!simulation) {
      return NextResponse.json({ error: 'Simulation not found' }, { status: 404 });
    }

    // Classic (v1 and legacy v0): Σ capital of enabled sides. Combo: Σ both
    // sides (unchanged behaviour, supervisorRunner.ts).
    const startingCapital = simulation.gridConfigs
      .filter(c => simulation.comboBotEnabled || c.enabled)
      .reduce((sum, c) => sum + c.totalCapital, 0);

    return NextResponse.json({ simulation: { ...simulation, startingCapital } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE: Remove simulation and all related data
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await prisma.simulation.delete({
      where: { id: params.id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

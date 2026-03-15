import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

// GET: List saved configurations
export async function GET() {
  try {
    const configs = await prisma.savedConfiguration.findMany({
      orderBy: { updatedAt: 'desc' },
    });
    return NextResponse.json({ configurations: configs });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST: Save a new configuration preset
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, description, configJson, pair, longLevels, shortLevels, gridType } = body;

    if (!name || !configJson) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const config = await prisma.savedConfiguration.create({
      data: {
        name,
        description: description || '',
        configJson: typeof configJson === 'string' ? configJson : JSON.stringify(configJson),
        pair: pair || '',
        longLevels: longLevels || 10,
        shortLevels: shortLevels || 10,
        gridType: gridType || 'arithmetic',
      },
    });

    return NextResponse.json({ configuration: config });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

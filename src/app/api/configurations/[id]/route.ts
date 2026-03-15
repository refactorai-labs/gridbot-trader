import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

// GET: Load a saved configuration
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const config = await prisma.savedConfiguration.findUnique({
      where: { id: params.id },
    });

    if (!config) {
      return NextResponse.json({ error: 'Configuration not found' }, { status: 404 });
    }

    return NextResponse.json({ configuration: config });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PUT: Update a configuration
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();

    const config = await prisma.savedConfiguration.update({
      where: { id: params.id },
      data: {
        name: body.name,
        description: body.description,
        configJson: typeof body.configJson === 'string' ? body.configJson : JSON.stringify(body.configJson),
        pair: body.pair,
        longLevels: body.longLevels,
        shortLevels: body.shortLevels,
        gridType: body.gridType,
      },
    });

    return NextResponse.json({ configuration: config });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE: Remove a configuration
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await prisma.savedConfiguration.delete({
      where: { id: params.id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

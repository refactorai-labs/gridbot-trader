// Serves research artifacts (JSON files written by scripts/research/*) to the
// /research dashboard. GET with no params lists available artifacts.

import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

const ARTIFACT_DIR = path.join(process.cwd(), 'research-artifacts');

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get('name');

  if (!name) {
    const files = fs.existsSync(ARTIFACT_DIR)
      ? fs.readdirSync(ARTIFACT_DIR).filter(f => f.endsWith('.json'))
      : [];
    return NextResponse.json({ artifacts: files.map(f => f.replace(/\.json$/, '')).sort() });
  }

  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return NextResponse.json({ error: 'invalid artifact name' }, { status: 400 });
  }
  const file = path.join(ARTIFACT_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    return NextResponse.json({ error: 'artifact not found' }, { status: 404 });
  }
  return new NextResponse(fs.readFileSync(file, 'utf8'), {
    headers: { 'Content-Type': 'application/json' },
  });
}

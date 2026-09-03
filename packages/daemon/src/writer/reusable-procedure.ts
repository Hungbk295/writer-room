import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, writerProceduresRoot } from '../paths.ts';

const PROCEDURE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ReusableProcedure {
  id: string;
  description: string;
  instructions: string;
  path: string;
  hash: string;
}

export interface ReusableProcedureInput {
  id: string;
  description: string;
  instructions: string;
}

function assertId(id: string): void {
  if (!PROCEDURE_ID.test(id) || id.length > 64) {
    throw new Error('Mã quy trình chỉ gồm chữ thường, số và dấu gạch ngang (tối đa 64 ký tự)');
  }
}

function cleanInput(input: ReusableProcedureInput): ReusableProcedureInput {
  const id = input.id.trim().toLowerCase();
  assertId(id);
  const description = input.description.replace(/\s+/g, ' ').trim();
  const instructions = input.instructions.trim();
  if (description.length < 20 || description.length > 500) {
    throw new Error('Mô tả quy trình cần 20–500 ký tự và nói rõ khi nào dùng');
  }
  if (instructions.length < 40) throw new Error('Hướng dẫn quy trình cần ít nhất 40 ký tự');
  if (Buffer.byteLength(instructions, 'utf8') > 128 * 1024) throw new Error('Quy trình quá lớn (tối đa 128 KB)');
  return { id, description, instructions };
}

function skillPath(id: string, dataDir: string): string {
  assertId(id);
  return join(writerProceduresRoot(dataDir), id, 'SKILL.md');
}

function renderSkill(input: ReusableProcedureInput): string {
  return [
    '---',
    `name: ${input.id}`,
    `description: ${JSON.stringify(input.description)}`,
    '---',
    '',
    input.instructions.trim(),
    '',
  ].join('\n');
}

function parseSkill(id: string, markdown: string): ReusableProcedure | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return null;
  const name = match[1]!.match(/^name:\s*([^\r\n]+)$/m)?.[1]?.trim();
  const rawDescription = match[1]!.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (name !== id || !rawDescription) return null;
  let description = rawDescription;
  try { description = JSON.parse(rawDescription) as string; } catch { /* plain YAML scalar */ }
  const instructions = match[2]!.trim();
  return {
    id,
    description,
    instructions,
    path: `.agents/skills/${id}/SKILL.md`,
    hash: createHash('sha256').update(markdown).digest('hex'),
  };
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

export async function getReusableProcedure(id: string, dataDir: string): Promise<ReusableProcedure | null> {
  try {
    const markdown = await readFile(skillPath(id, dataDir), 'utf8');
    return parseSkill(id, markdown);
  } catch {
    return null;
  }
}

export async function listReusableProcedures(dataDir: string): Promise<ReusableProcedure[]> {
  const root = writerProceduresRoot(dataDir);
  await ensureDir(root);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const skills = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && PROCEDURE_ID.test(entry.name))
    .map((entry) => getReusableProcedure(entry.name, dataDir)));
  return skills
    .filter((skill): skill is ReusableProcedure => Boolean(skill))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function createReusableProcedure(
  input: ReusableProcedureInput,
  dataDir: string,
): Promise<ReusableProcedure> {
  const clean = cleanInput(input);
  if (await getReusableProcedure(clean.id, dataDir)) throw new Error(`Quy trình "${clean.id}" đã tồn tại`);
  await ensureDir(join(writerProceduresRoot(dataDir), clean.id));
  await atomicWrite(skillPath(clean.id, dataDir), renderSkill(clean));
  return (await getReusableProcedure(clean.id, dataDir))!;
}

export async function updateReusableProcedure(
  id: string,
  input: ReusableProcedureInput,
  dataDir: string,
): Promise<ReusableProcedure> {
  if (!(await getReusableProcedure(id, dataDir))) throw new Error('Quy trình không tồn tại');
  const clean = cleanInput({ ...input, id });
  await atomicWrite(skillPath(id, dataDir), renderSkill(clean));
  return (await getReusableProcedure(id, dataDir))!;
}

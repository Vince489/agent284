import fs from 'fs/promises';
import path from 'path';

export async function loadConfig(fileName) {
  try {
    const filePath = path.resolve('config', fileName); // adjust if your folder is different
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error(`Failed to load config "${fileName}":`, err.message);
    throw err;
  }
}

export async function loadAllConfigs() {
  const [tasks, agents, workflows] = await Promise.all([
    loadConfig('tasks.json'),
    loadConfig('agents.json'),
    loadConfig('workflows.json')
  ]);

  return { tasks, agents, workflows };
}

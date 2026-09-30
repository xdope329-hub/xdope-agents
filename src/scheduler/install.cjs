// Registra en el Programador de tareas de Windows las ejecuciones definidas en config.schedule.
// Por defecto solo muestra los comandos; con --apply los crea (reemplazando los existentes); con --remove los borra.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DAYS = { lun: 'MON', mar: 'TUE', mie: 'WED', jue: 'THU', vie: 'FRI', sab: 'SAT', dom: 'SUN' };

const custom = path.join(ROOT, 'config', 'config.json');
const config = JSON.parse(fs.readFileSync(fs.existsSync(custom) ? custom : path.join(ROOT, 'config', 'config.example.json'), 'utf8'));
const { runs = [], collectEveryHours, taskFolder = 'xdope-agents' } = config.schedule || {};
const apply = process.argv.includes('--apply');
const remove = process.argv.includes('--remove');

const tasks = [];
runs.forEach((run, i) => {
  const days = run.days.map((d) => {
    if (!DAYS[d]) throw new Error(`Día inválido "${d}" (usa: ${Object.keys(DAYS).join(', ')})`);
    return DAYS[d];
  });
  for (const time of run.times) {
    tasks.push({
      name: `${taskFolder}\\run-${i + 1}-${time.replace(':', '')}`,
      args: ['/SC', 'WEEKLY', '/D', days.join(','), '/ST', time],
      cmd: `--designs ${run.designsPerRun ?? config.batch.designsPerRun}`,
    });
  }
});
// Recoge lotes terminados (Anthropic/Gemini batch) entre ejecuciones programadas.
if (collectEveryHours) {
  tasks.push({
    name: `${taskFolder}\\collect`,
    args: ['/SC', 'HOURLY', '/MO', String(collectEveryHours)],
    cmd: '--collect-only',
  });
}

const runner = path.join(ROOT, 'scripts', 'run-pipeline.cmd');
for (const t of tasks) {
  const args = remove
    ? ['/Delete', '/F', '/TN', t.name]
    : ['/Create', '/F', '/TN', t.name, ...t.args, '/TR', `"${runner}" ${t.cmd}`];
  console.log(`schtasks ${args.map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(' ')}`);
  if (apply || remove) execFileSync('schtasks', args, { stdio: 'inherit' });
}
if (!apply && !remove) {
  console.log(`\n${tasks.length} tareas (vista previa). "npm run schedule:install -- --apply" las crea; "-- --remove" las borra.`);
}

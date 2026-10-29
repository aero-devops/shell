import { createSupervisor } from '../src/index.js';

const supervisor = createSupervisor();
const handle = supervisor.start('hello', {
  command: process.execPath,
  args: ['-e', 'console.log("Aero Shell started a local process.")'],
});
await handle.completion;
console.log(supervisor.status('hello'));
console.log(supervisor.logs('hello'));


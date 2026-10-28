import { migrateDb } from '../db/migrate.ts';
import { bootstrap } from './bootstrap.ts';
import { resetPassword } from './reset-password.ts';
import type { CliEnv, ExitCode } from './types.ts';

const USAGE = `usage: netschool-admin <command>
  migrate
  bootstrap --org <name> --site <name> --admin <username> [--display-name <name>]
  reset-password <username>
`;

export async function run(argv: string[], env: CliEnv): Promise<ExitCode> {
  const [command, ...rest] = argv;
  await migrateDb(env.db, env.driver);
  switch (command) {
    case 'migrate':
      env.stdout.write('migrations applied\n');
      return 0;
    case 'bootstrap':
      return bootstrap(rest, env);
    case 'reset-password':
      return resetPassword(rest, env);
    default:
      env.stdout.write(USAGE);
      return 1;
  }
}

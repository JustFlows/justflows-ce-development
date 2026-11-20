import { statusCommand } from "./commands/status.js";
import { pluginCommand } from "./commands/plugin.js";
import { themeCommand } from "./commands/theme.js";
import { userCommand } from "./commands/user.js";
import { dbCommand } from "./commands/db.js";
import { cacheCommand } from "./commands/cache.js";
import { exportCommand } from "./commands/export.js";
import { healthCommand } from "./commands/health.js";
import { updateCommand } from "./commands/update.js";
import { checkCommand } from "./commands/check.js";
import { submitCommand } from "./commands/submit.js";

const VERSION = "0.1.2";

const HELP = `
Justflows CLI v${VERSION}

Usage: justflows <command> [subcommand] [options]

Commands:
  status                  Show installation status
  plugin list             List installed plugins
  plugin install <path>   Install a plugin from a .jfpkg file
  plugin activate <id>    Activate a plugin
  plugin deactivate <id>  Deactivate a plugin
  theme list              List installed themes
  theme activate <id>     Activate a theme
  theme templates         List the active theme's templates and their status
  theme scaffold <slug>   Create a new theme skeleton under ./themes/<slug>
  user create             Create a new user interactively
  user reset-password     Reset a password from the server host (offline fallback)
  db migrate              Run pending database migrations
  cache clear             Clear the application cache
  export static           Write published pages + assets to STATIC_EXPORT_DIR
  health                  Run site health checks
  check <folder|.jfpkg>   Check a plugin, theme, or CSS provider before publishing
  submit [folder]         Send plugin or theme source to a registry (off on the Justflows Marketplace)
  update                  Check for and apply updates

Options:
  --help, -h              Show help
  --version, -v           Show version

Environment:
  ADMIN_URL               URL of the admin app (default: http://localhost:3001)
  JUSTFLOWS_PUBLISHER_TOKEN  Publisher token with the submit scope (justflows submit)
  JUSTFLOWS_REGISTRY_URL     Marketplace API (default: https://api.justflows.com)
`.trim();

export async function run(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
    return;
  }

  if (args[0] === "--version" || args[0] === "-v") {
    console.log(`justflows v${VERSION}`);
    return;
  }

  const [command, ...rest] = args as [string, ...string[]];

  try {
    switch (command) {
      case "status":
        await statusCommand(rest);
        break;
      case "plugin":
        await pluginCommand(rest);
        break;
      case "theme":
        await themeCommand(rest);
        break;
      case "user":
        await userCommand(rest);
        break;
      case "db":
        await dbCommand(rest);
        break;
      case "cache":
        await cacheCommand(rest);
        break;
      case "export":
        await exportCommand(rest);
        break;
      case "health":
        await healthCommand(rest);
        break;
      case "update":
        await updateCommand(rest);
        break;
      case "check":
        await checkCommand(rest);
        break;
      case "submit":
        await submitCommand(rest);
        break;
      default:
        console.error(`Unknown command: ${command}\nRun "justflows --help" for usage.`);
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Error: ${String(err)}`);
    process.exitCode = 1;
  }
}

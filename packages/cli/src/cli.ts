#!/usr/bin/env node
/**
 * Justflows CLI — justflows <command> [options]
 *
 * Usage:
 *   justflows status
 *   justflows plugin list
 *   justflows plugin install <path>
 *   justflows plugin activate <id>
 *   justflows plugin deactivate <id>
 *   justflows theme list
 *   justflows theme activate <id>
 *   justflows user create
 *   justflows user reset-password --email you@example.com
 *   justflows db migrate
 *   justflows cache clear
 *   justflows health
 *   justflows update
 *   justflows submit [folder]
 */

import { run } from "./runner.js";

run(process.argv.slice(2));

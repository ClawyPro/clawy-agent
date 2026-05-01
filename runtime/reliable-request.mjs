#!/usr/bin/env node

import { main } from "../dist/reliability/reliableRequestCli.js";

await main(process.argv.slice(2));

#!/usr/bin/env node
import { rmSync } from 'node:fs'
import { join } from 'node:path'

rmSync(join(process.cwd(), 'lib'), { recursive: true, force: true })

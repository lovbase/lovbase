import type { Case } from '../types'
import { cases as add } from './add'
import { cases as adversarial } from './adversarial'
import { cases as ambiguous } from './ambiguous'
import { cases as destructive } from './destructive'
import { cases as judgment } from './judgment'
import { cases as preserve } from './preserve'
import { cases as rename } from './rename'

export const allCases: Case[] = [...add, ...rename, ...judgment, ...destructive, ...preserve, ...ambiguous, ...adversarial]

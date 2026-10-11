import { useMemo } from 'react'
import { useStore } from '../state/store.ts'
import { createTranslator, type Translator } from './index.ts'

export function useT(): Translator {
  const locale = useStore(s => s.locale)
  return useMemo(() => createTranslator(locale), [locale])
}

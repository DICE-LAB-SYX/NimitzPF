import { useMemo } from 'react'
import { useRealm } from '../live/store.ts'
import { useStore } from '../state/store.ts'
import { createTranslator, type Translator } from './index.ts'

export function useT(): Translator {
  const locale = useStore(s => s.locale)
  const realm = useRealm()
  return useMemo(() => createTranslator(locale, realm), [locale, realm])
}

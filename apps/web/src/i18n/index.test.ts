import { describe, expect, it } from 'vitest'
import { asset } from '../game/assets.ts'
import { createTranslator } from './index.ts'

describe('CN server wording', () => {
  it('uses the zh-cn game strings and terms on cn360', () => {
    const t = createTranslator('zh-Hans', 'cn360')
    expect(t.enemyName('boss_1')).toBe('鲸')
    expect(t.cardName('card_7').unit).toBe('密苏里')
    expect(t.modifier('focused')).toBe('专注')
    expect(t.game('IDS_OPERATION_NAME_OP_03')).toBe('查理')
    expect(t('keypointN', { n: 2 })).toBe('关键节点2')
    expect(t('modifierStandard')).toBe('标准修改器')
    expect(t('scopeGlobal')).toBe('全局')
  })

  it('keeps the Asia wording on other realms and in other locales', () => {
    expect(createTranslator('zh-Hans', 'sg').enemyName('boss_1')).toBe('大和')
    expect(createTranslator('zh-Hans')('keypointN', { n: 2 })).toBe('关键据点2')
    expect(createTranslator('zh-Hant', 'cn360')('keypointN', { n: 2 })).toBe('關鍵據點2')
    expect(createTranslator('en', 'cn360').modifier('focused')).toBe(createTranslator('en').modifier('focused'))
  })

  it('swaps in the CN art only where the game has it', () => {
    expect(asset.card('card_1', 'cn360')).toMatch(/\/game\/cn\/cards\/card_1\.webp$/)
    expect(asset.enemy('vehicle_3', 'cn360')).toMatch(/\/game\/cn\/enemies\/vehicle_3\.webp$/)
    expect(asset.card('card_7', 'cn360')).toMatch(/\/game\/cards\/card_7\.webp$/)
    expect(asset.card('card_1', 'sg')).toMatch(/\/game\/cards\/card_1\.webp$/)
  })
})

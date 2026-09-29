import { describe, expect, it } from 'vitest';
import { CANONICAL_INGREDIENTS, findCanonicalIngredient, normalizeIngredientText } from '../../packages/domain/src';

describe('conservative Vietnamese OCR canonicalization', () => {
  it.each(['Cà chua', 'ca chua', 'CÀ CHUA', 'Cà-chua', 'Ca chua 1kg', 'Cà chua 1 kg'])(
    'maps %s to TOMATO', (label) => {
      expect(findCanonicalIngredient(label)?.id).toBe('TOMATO');
    },
  );

  it('keeps unknown and species-specific labels unresolved', () => {
    for (const label of ['trứng vịt', 'cà chua bi lạ', 'bánh cà chua', 'SKU-TOMATO-123']) {
      expect(findCanonicalIngredient(label)).toBeNull();
    }
    expect(findCanonicalIngredient('trứng gà')?.id).toBe('CHICKEN_EGG');
    expect(findCanonicalIngredient('NOT_IN_CATALOG')).toBeNull();
  });

  it('does not label generic eggs as chicken eggs or mozzarella as cheddar', () => {
    for (const label of ['trứng', 'trứng 10 quả', 'mozzarella', 'Mozzarella 200 g']) {
      expect(findCanonicalIngredient(label)).toBeNull();
    }
    expect(findCanonicalIngredient('trứng gà')?.id).toBe('CHICKEN_EGG');
    expect(findCanonicalIngredient('cheddar')?.id).toBe('CHEDDAR_CHEESE');
  });

  it('has no cross-ID normalized alias collision', () => {
    const owners = new Map<string, string>();
    for (const ingredient of CANONICAL_INGREDIENTS) {
      for (const label of [ingredient.nameVi, ingredient.nameEn, ...ingredient.aliases]) {
        const key = normalizeIngredientText(label);
        expect(owners.get(key) ?? ingredient.id).toBe(ingredient.id);
        owners.set(key, ingredient.id);
      }
    }
  });
});

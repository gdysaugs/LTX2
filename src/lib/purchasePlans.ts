export type PurchasePlan = {
  id: string
  label: string
  price: number
  tickets: number
  priceId: string
}

export const PURCHASE_PLANS: PurchasePlan[] = [
  { id: 'light', label: 'ライト', price: 700, tickets: 30, priceId: 'price_1St4C9AL4umhcfEPAVXlq2RJ' },
  { id: 'standard', label: 'スタンダード', price: 1500, tickets: 80, priceId: 'price_1St4CaAL4umhcfEP3UzuJtTy' },
  { id: 'pro', label: 'プロ', price: 3200, tickets: 200, priceId: 'price_1St4D7AL4umhcfEPY3qOc74l' },
]

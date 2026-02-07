export type PurchasePlan = {
  id: string
  label: string
  price: number
  tickets: number
  priceId: string
}

export const PURCHASE_PLANS: PurchasePlan[] = [
  { id: 'starter', label: 'Starter', price: 600, tickets: 20, priceId: 'price_1Sy5N6Abw0uHQjne0Q6aV0M1' },
  { id: 'basic', label: 'Basic', price: 2000, tickets: 80, priceId: 'price_1Sy5QbAbw0uHQjne0wydR1AG' },
  { id: 'plus', label: 'Plus', price: 4000, tickets: 200, priceId: 'price_1Sy5QqAbw0uHQjneTnEIOCFx' },
  { id: 'pro', label: 'Pro', price: 9000, tickets: 500, priceId: 'price_1Sy5R3Abw0uHQjnekmxX7Q5n' },
]

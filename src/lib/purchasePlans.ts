export type PurchasePlan = {
  id: string
  label: string
  price: number
  tickets: number
  priceId: string
}

export const PURCHASE_PLANS: PurchasePlan[] = [
  { id: 'mini', label: 'ミニパック', price: 480, tickets: 30, priceId: 'price_1T0FbRADIkb9D0vbJU219i32' },
  { id: 'value', label: 'お得パック', price: 1200, tickets: 80, priceId: 'price_1T0FcJADIkb9D0vbswnpncgW' },
  { id: 'bulk', label: '大容量パック', price: 2800, tickets: 200, priceId: 'price_1T0Ff0ADIkb9D0vbdH1cayHz' },
]

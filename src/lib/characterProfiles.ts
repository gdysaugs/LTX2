export type CharacterProfile = {
  id: string
  name: string
  handle: string
  title: string
  location?: string
  bio: string
  motto: string
  image: string
}

export const CHARACTER_PROFILES: CharacterProfile[] = [
  {
    id: 'ayaka',
    name: 'Ayaka',
    handle: '@ayaka',
    title: 'Private investor focused on risk control',
    location: 'Los Angeles',
    bio:
      'Early 20s: debt and job loss -> discovered XM and learned FX -> blew up early accounts -> rebuilt with strict risk rules -> reached eight-figure net worth over time.',
    motto: 'Survive first. Process beats hype. Consistency beats luck.',
    image: '/media/ayaka.png',
  },
]

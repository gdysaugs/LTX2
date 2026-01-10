# XM Chat

Simple chat site that uses:
- Supabase (Google OAuth + message storage)
- OpenAI API (via Cloudflare Pages Functions)

## Setup

1) Install deps
```
npm install
```

2) Env vars
Create `.env` from `.env.example`:
```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
VITE_SUPABASE_REDIRECT_URL=https://your-domain
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o-mini
```

3) Supabase table
```
create table public.chat_messages (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  character_id text not null,
  role text not null,
  content text not null,
  created_at timestamp with time zone not null default now(),
  constraint chat_messages_pkey primary key (id)
);

create index if not exists chat_messages_user_idx on public.chat_messages using btree (user_id);
create index if not exists chat_messages_character_idx on public.chat_messages using btree (character_id);
```

4) Run locally
```
npm run dev
```

## Cloudflare Pages

Build command:
```
npm run build
```

Output dir:
```
dist
```

Set environment variables in Pages -> Settings -> Environment variables.

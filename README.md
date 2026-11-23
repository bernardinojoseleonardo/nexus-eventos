# NEXUS EVENTOS

Plataforma estática de eventos ligada ao Supabase. A interface atual está em `outputs/index.html` e a integração de autenticação, eventos, reservas e relatórios em `outputs/nexus-supabase.js`.

## Estado da integração

- Supabase: projeto `nexus-eventos`, na região `eu-west-1`; migrações aplicadas.
- Vercel: projeto `nexus-eventos` ligado ao GitHub; variáveis públicas do Supabase configuradas.
- Reservas ficam pendentes. Pagamentos reais e confirmação automática ainda não estão integrados.
- O papel `admin` deve ser atribuído manualmente a uma conta confiável no SQL Editor do Supabase.

## Ativação do Supabase

1. O projeto está em `https://supabase.com/dashboard/project/dgxiqvyfbbohqwnrgyuu`.
2. Em **Authentication > URL Configuration**, definir o site e redirecionamentos para `https://nexus-eventos-alpha.vercel.app`.
3. Em **Authentication > Providers > Email**, desligar **Confirm email** para permitir cadastro e entrada imediata sem código ou link. A recuperação de palavra-passe continua a depender de e-mails a funcionar.
4. Atribuir `admin` à conta do proprietário no SQL Editor, após o registo: `update public.profiles set role = 'admin' where id = (select id from auth.users where email = 'EMAIL_DO_ADMIN');`.
5. Nunca enviar a chave `service_role` ao browser ou guardá-la no repositório.

## GitHub e Vercel

O repositório é `bernardinojoseleonardo/nexus-eventos`. A branch `main` publica em produção; cada push gera uma publicação, e branches de pull request geram pré-visualizações. O build copia `outputs/` para `dist/` e cria `nexus-config.js` com as variáveis de ambiente `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY`.

## Relatórios e comissão

O relatório administrativo separa reservas de pagamentos confirmados. A coluna `confirmed_gross` soma apenas pedidos pagos; a migração não configura um gateway de pagamento nem marca reservas como pagas automaticamente. O cálculo da comissão precisa ser implementado no fluxo de pagamento/webhook antes de representar receita efetivamente recebida pela NEXUS.


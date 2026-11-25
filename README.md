# NEXUS EVENTOS

Plataforma estática de eventos ligada ao Supabase. A interface atual está em `outputs/index.html` e a integração de autenticação, eventos, reservas e relatórios em `outputs/nexus-supabase.js`.

## Estado da integração

- Supabase: projeto `nexus-eventos`, na região `eu-west-1`; aplique as migrações pendentes antes de atualizar a base de dados.
- Vercel: projeto `nexus-eventos` ligado ao GitHub; variáveis públicas do Supabase configuradas.
- As reservas de ingressos expiram após 15 minutos; a validação do pagamento continua manual, pois não há gateway integrado.
- O papel `admin` deve ser atribuído manualmente a uma conta confiável no SQL Editor do Supabase.
- Clientes e organizadores cadastram-se com nome, telefone e palavra-passe, e entram apenas com telefone e palavra-passe. O Supabase impede mais de uma conta de autenticação por telefone. O anúncio público mostra nome, foto de perfil, telefone e imagens do evento; o número do BI fica numa tabela com leitura limitada a administradores.
- Organizadores aprovados podem enviar anúncios. Cada anúncio de organizador exige a taxa de publicação de 2 000 Kz e permanece privado até a administração confirmar o pagamento.

## Ativação do Supabase

1. O projeto está em `https://supabase.com/dashboard/project/dgxiqvyfbbohqwnrgyuu`.
2. Em **Authentication > URL Configuration**, definir o site e redirecionamentos para `https://nexus-eventos-alpha.vercel.app`.
3. Em **Authentication > Providers > Phone**, ativar a autenticação telefónica e configurar um provedor SMS com as credenciais diretamente no painel Supabase. Desligar **Confirm phone** para permitir cadastro sem código SMS; o provedor continua necessário para recuperar a palavra-passe. Nunca enviar credenciais pelo chat nem guardá-las no repositório.
4. Não é necessário e-mail para contas de clientes ou organizadores. É aceite apenas uma conta por telefone; o Supabase aplica a unicidade na autenticação.
5. Os telefones locais são normalizados com o indicativo de Angola (`+244`); também são aceites números internacionais em formato E.164.
6. Atribuir `admin` à conta do proprietário no SQL Editor, após o registo: `update public.profiles set role = 'admin' where id = (select id from auth.users where email = 'EMAIL_DO_ADMIN');`. O acesso administrativo separado continua a usar e-mail.
7. Nunca enviar a chave `service_role` ao browser ou guardá-la no repositório.

## GitHub e Vercel

O repositório é `bernardinojoseleonardo/nexus-eventos`. A branch `main` publica em produção; cada push gera uma publicação, e branches de pull request geram pré-visualizações. O build copia `outputs/` para `dist/` e cria `nexus-config.js` com as variáveis de ambiente `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY`.

## Relatórios e comissão

O relatório administrativo separa reservas de pagamentos confirmados. A coluna `confirmed_gross` soma apenas pedidos pagos; a migração não configura um gateway de pagamento nem marca reservas como pagas automaticamente. O cálculo da comissão precisa ser implementado no fluxo de pagamento/webhook antes de representar receita efetivamente recebida pela NEXUS.

## Reservas e disponibilidade de ingressos

A migração `supabase/migrations/20261125120000_ticket_reservation_expiration.sql` implementa o inventário atual por evento, sem assentos numerados. O checkout cria reservas através de `create_ticket_order`, que bloqueia a linha do evento, verifica o estoque e grava a expiração em uma única transação. São permitidos até 4 ingressos por pedido, com validade de 15 minutos.

Ingressos pagos e reservas ainda válidas contam para a lotação. Quando a reserva expira, deixa de ocupar estoque e a disponibilidade é liberada; a consulta de disponibilidade ou a próxima reserva também atualiza a reserva pendente para expirada. O painel não permite confirmar pagamentos de reservas vencidas. A confirmação manual válida emite o código digital do ingresso. Webhooks, QR dinâmico e lugares marcados não estão incluídos: dependem de gateway ou modelagem adicional.

## Taxa de publicação de eventos

O organizador paga 2 000 Kz fora da plataforma, informa o método e a referência do comprovativo no formulário e aguarda a validação de um administrador. A confirmação publica o evento e gera um código de recibo, que o organizador pode imprimir/guardar em PDF na área da conta. A plataforma não processa nem confirma transferências automaticamente; a administração deve validar o pagamento antes de o confirmar no painel.

Ao aplicar a migração `supabase/migrations/20261125090000_enforce_event_publication_fee.sql`, o banco também impede a publicação de eventos de organizadores sem um pagamento confirmado. Eventos criados anteriormente permanecem inalterados.


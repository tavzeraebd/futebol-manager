-- "Despertador" dos jogos marcados: o plano grátis do Render dorme depois de ~15 min sem acesso. A cada 5 minutos o próprio
-- Supabase olha se há jogo marcado começando nos próximos 20 minutos (ou que começou há menos de 15) e, se houver, chama o
-- site, que acorda a tempo de o jogo sair no horário e ser assistido ao vivo. Fora desses horários ninguém acorda o servidor.
-- (Se o servidor mesmo assim estiver dormindo no horário, ele joga os atrasados assim que acordar: o resultado é o mesmo.)

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.wake_for_fixtures() returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from public.league_fixtures
    where score is null and kickoff_at between now() - interval '15 minutes' and now() + interval '20 minutes'
  ) then
    perform net.http_get('https://futebol-manager.onrender.com/api/wake', timeout_milliseconds := 30000);
  end if;
end $$;
revoke all on function public.wake_for_fixtures() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'fm-wake-fixtures';
select cron.schedule('fm-wake-fixtures', '*/5 * * * *', 'select public.wake_for_fixtures()');

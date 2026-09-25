# Football Manager Online

## Rodar
    node server/server.js      # ou: npm start
    # abra http://localhost:3210  (troque com PORT=xxxx)
Para testar com 2 jogadores, abra a URL em duas abas anônimas ou em dois navegadores.

## Como funciona
- Cada clube começa com € 500 M. Contrate jogadores/técnico pelo valor de mercado (cada um pertence a um só clube).
- Comprar custa valor de mercado + 20%; vender devolve 75%. Elenco máx. 25. Escale 11 (4-2-3-1, 4-3-3, 4-4-2, 3-5-2).
- Desafie um clube online (ele aceita/recusa) ou teste sua escalação contra a CPU (não vale pontos nem dinheiro; classificação e prêmios só em jogos entre jogadores). O servidor simula com `js/engine.js`
  usando uma semente; os dois clientes reproduzem a mesma partida no campo.
- Em partidas entre dois jogadores, pausa/velocidade/pular valem para os dois ao mesmo tempo (o servidor guarda o relógio da partida). Contra a CPU e ao rever partidas antigas, os controles são só seus.
- Nota do jogador -> habilidades no motor; a nota do técnico dá um bônus ao time inteiro.

## Ligas e copas entre amigos (aba "Ligas e copas")
- Crie uma sala (Liga de pontos corridos, turno único ou ida e volta, até 12 clubes; ou Copa mata-mata, até 16) e passe o
  código de 6 letras para os amigos entrarem. Só o dono inicia. Depois de iniciada, ninguém entra.
- Jogos: "Chamar para jogar" desafia o adversário (ele precisa estar online; os dois assistem juntos, com controles
  sincronizados). O dono da sala pode "Simular" um jogo se o adversário estiver ausente.
- Copa: empate vai para prorrogação (2x15 min) e depois pênaltis. Com número ímpar de clubes, alguns folgam na 1ª fase.
- Campeão ganha € 30 M e o vice € 10 M. A liga tem tabela e artilheiros.

## Chat, reações e narração
- Partidas entre dois jogadores têm chat, reações com emoji (flutuam sobre o campo para os dois) e provocações prontas.
  Mensagens têm limite de 140 letras e de velocidade; palavrões básicos viram ***, links viram [link]. A sala da liga tem chat próprio.
- Narração em texto (todos os lances) e em voz (voz do navegador, pt-BR) e som de torcida, gol e apito (gerado no navegador,
  sem arquivos). Os botões Som/Voz ficam ao lado da narração e a escolha é lembrada. Ao pular para o fim, o narrador fica mudo.
- A narração conta a jogada lance a lance com os nomes: "Hudson-Odoi toca para Nico Williams, Nico Williams cruza para
  Lewandowski e GOOOOL! Lewandowski marca...", além de chutes, defesas, desarmes e cortes. A voz fala cada lance na hora e
  nunca fica atrás da bola: gol, chute e defesa interrompem a fala anterior; passe e desarme só falam se a voz estiver livre.
- A simulação usa matemática própria (só + - * / e raiz), então dois navegadores diferentes veem exatamente o mesmo jogo.
  Se o servidor for atualizado com a página aberta, a aba recarrega sozinha ao abrir uma partida.
- Navegadores só liberam áudio depois de um clique na página; se ficar mudo, clique em qualquer lugar.

## Leilão ao vivo e trocas (aba "Leilões e trocas")
- Só vai a leilão jogador (ou técnico) que já é do seu clube: o dono leiloa o dele (botão "Leiloar" no Elenco). Quem está no mercado, sem
  clube, não pode ser leiloado por ninguém: contrata-se direto (o servidor recusa). 45 s de relógio; lance nos últimos 10 s estende o tempo. Lance mínimo sobe 5% (mín. €1M).
  O vencedor paga o valor cheio ao vendedor (sem o desconto de 25% da venda ao banco). Máx. 2 leilões abertos por clube.
- O dinheiro dos lances vencendo fica reservado (não dá para dar lances acima do saldo em vários leilões) e vale a vaga do elenco.
- Trocas: escolha o clube, marque quem você dá e quem recebe (até 5 de cada lado) e, se quiser, dinheiro. O outro aceita ou recusa;
  a troca é conferida de novo ao aceitar (dono, saldo, elenco máx. 25, um técnico por clube). Itens em leilão/troca ficam travados.

## Tática e substituições (aba "Escalação e tática")
- Estilos: Equilibrado, Ofensivo, Retranca, Contra-ataque e Pressão alta. Além disso, planeje até 5 trocas e 3 mudanças de tática
  em minutos combinados; elas acontecem na primeira bola parada depois do minuto (ou no intervalo) e são narradas.

## Jogar você mesmo (aba "Jogar")
- "Jogar (eu controlo)": contra a CPU ou contra o time de um amigo; você controla o jogador mais próximo da bola.
  W A S D ou setas mover, Q/Espaço passe (para quem está na direção que você aponta), E chute, Shift correr. No celular aparecem botões na tela.
- "2 jogadores no mesmo teclado": P1 com W A S D + Q + E + Shift; P2 com setas + K + L + Shift direito.
- É treino: não vale prêmio nem pontos e não fica no histórico.

## Celular (Android e iOS)
O jogo funciona no navegador do celular e pode ser instalado como app (PWA): no **iPhone/iPad** abra no Safari > Compartilhar > "Adicionar à Tela de Início";
no **Android** use o menu do Chrome > "Instalar app" (ou "Adicionar à tela inicial").
- Layout (visual em `css/theme.css`, portal claro com verde de gramado): no computador, barra superior (escudo, busca no mercado, saldo, fonte de dados e
  menu da conta no avatar) e barra lateral com ícones; entre 1024 e 1279 px a lateral vira um trilho compacto. Abaixo de 1024 px aparece a barra de
  navegação inferior (Início · Escalação · ⚽ Jogar · Mercado · Menu) e o "Menu" abre a lista completa numa gaveta lateral; com o celular deitado a
  barra inferior some e a gaveta abre pelo ☰ do topo. A aba Início resume o clube (estádio, classificação, saldo, campanha, condição, últimos jogos e
  destaques). Até 900 px Mercado, Elenco e Partidas viram cartões com o botão de contratar à vista (2 colunas no tablet). Respeita o notch e a barra de
  gestos do iPhone (`viewport-fit=cover` + `env(safe-area-inset-*)`); campos com 16 px (o iOS não dá zoom ao digitar); alvos de toque de ~40 px.
  Os ajustes de toque e de telas pequenas estão em `css/mobile.css`.
- Partida: em pé o campo ocupa a largura com uma dica para virar o aparelho; deitado o campo ocupa a altura da tela. No "jogar você mesmo" aparecem
  os botões na tela (cruzeta e CORRER/PASSE/CHUTE; deitado eles flutuam nas laterais). A tela fica acesa durante a partida (Wake Lock).
- Som e voz: o navegador só libera áudio depois de um toque; o primeiro toque na página destrava os dois. **No iPhone o áudio pode ficar mudo com a
  chave lateral em "silencioso"** (o jogo pede a sessão de reprodução, mas versões antigas do iOS ignoram).
- Conexão: ao sair do app e voltar (ou trocar de rede) o jogo reabre a conexão em tempo real e atualiza a aba. Com o app em segundo plano você aparece
  como offline para os amigos (ninguém consegue te desafiar).
- O login com Google pode falhar dentro do app instalado no iPhone (o iOS trata pop-ups de PWA de um jeito diferente do Safari; não testei em aparelho
  real): por garantia, defina uma senha no menu da conta (avatar no topo) e entre com o nome do clube e a senha.

## Login com Google (clube persistente)
Sem login, o clube fica preso ao navegador (se limpar os dados, perde o acesso). Com o Google, o clube fica ligado à sua conta.
1. Acesse https://console.cloud.google.com > crie/seleciona um projeto > "APIs e serviços" > "Tela de permissão OAuth"
   (tipo Externo; adicione seu e-mail como usuário de teste).
2. "Credenciais" > "Criar credenciais" > "ID do cliente OAuth" > tipo "Aplicativo da Web".
3. Em "Origens JavaScript autorizadas" adicione exatamente: `http://localhost:3210`
   (e a URL pública, se hospedar o jogo; a porta precisa ser a mesma).
4. Copie o ID do cliente e ponha em `config.local.json` (veja `config.example.json`) ou na variável `GOOGLE_CLIENT_ID`.
5. Reinicie o servidor (`iniciar.bat`). A tela inicial passa a mostrar o botão "Fazer login com o Google".
Clubes já criados sem login mostram o botão "Continuar com o Google" no menu da conta (avatar no topo) para se vincularem.
O servidor valida a assinatura do token do Google (sem guardar senha); você pode entrar em vários dispositivos.

## Banco de dados (Supabase)
Tudo o que precisa persistir (clubes, elencos, partidas, ligas/copas, trocas, jogadores importados) fica no projeto Supabase
`futebol-manager`, nas tabelas `clubs`, `club_players`, `matches`, `leagues`, `league_members`, `league_fixtures`,
`trades`, `imported_players`, `player_form`, `player_stats` e `player_training` (RLS ligado, sem policies: só o servidor acessa).
1. `npm install`
2. Em Project Settings > API Keys do Supabase, copie a chave **service_role** e ponha em `config.local.json`
   (`supabaseServiceRoleKey`, veja `config.example.json`) ou na variável `SUPABASE_SERVICE_ROLE_KEY`. Nunca a exponha no navegador.
3. Uma vez, para copiar os dados antigos: `npm run migrate` (lê `data/db.json`).
4. `iniciar.bat` / `npm start`.

## Forma dos jogadores e técnicos
Depois de cada partida **entre jogadores** (a CPU é só teste), a nota de quem atuou (titulares e quem entrou) e do técnico muda:
- **Resultado:** vitória sobe, derrota desce (empate ~0; decisão nos pênaltis vale metade).
- **Desempenho individual** (medido nos eventos da partida): goleiro (defesas, gols sofridos, jogo sem sofrer gol), defensores
  (desarmes/interceptações, gols sofridos, faltas e cartões), meias (passes, passes de risco, chutes no gol) e atacantes (gols,
  chutes no gol, chutes desperdiçados, cruzamentos e lançamentos).
- O valor de mercado acompanha (~6% por ponto de nota). A forma acumulada vai de −8 a +8 pontos e fica na tabela `player_form`.
  A nota efetiva já entra na simulação das partidas seguintes. Clicando em qualquer jogador ou técnico aparece a ficha
  (características, nota, valor, forma). Cada clube recebe um aviso com quem subiu e quem caiu.

## Centro de Treinamento e condição física (aba "Centro de Treino")
Cada jogador tem **condição física** (0 a 100%) e pode **treinar** para melhorar as características. Tudo fica com o jogador (se ele for vendido, vai junto)
e está na tabela `player_training`.
- **Treino:** escolha o foco (Finalização, Passe, Drible, Defesa, Velocidade, Resistência ou "Automático", o que mais ajuda na posição) e a intensidade:
  Leve (+0,5 por sessão, gasta 8% de condição, pede 30%), Normal (+1, gasta 15%, pede 40%) ou Forte (+1,6, gasta 25%, pede 55%). Cada jogador treina até
  **2 vezes por dia** (renova à meia-noite de Brasília). O ganho diminui perto do teto de **+10 por característica**; técnico bom rende mais (sem técnico, 15% menos)
  e jogador de até 21 anos evolui 30% mais rápido (acima de 30, mais devagar; só vale para quem tem idade conhecida). Goleiro treina defesa do gol, passe,
  velocidade e resistência.
- **Efeito:** cada ponto treinado vale, naquela característica, o mesmo que um ponto de nota no motor; velocidade treinada aumenta a velocidade máxima e
  resistência faz o jogador cansar mais devagar em campo. A nota geral sobe pela média do que importa na posição (tudo no teto = +8) e o valor de mercado acompanha.
- **Condição física:** volta 4% por hora; em **descanso**, 8% por hora (sai do descanso ao treinar ou jogar). **Fisioterapia** devolve 30% na hora, 1 vez por dia,
  e custa 2% do valor do jogador (mínimo € 1 M). Uma partida inteira entre jogadores gasta cerca de 25% a 30% (meio-campo corre mais; goleiro, menos).
  Jogos contra a CPU e o "jogar você mesmo" não gastam condição.
- **Na partida:** o jogador começa com a energia igual à condição e cansa ao longo do jogo (mais quando corre no limite). Abaixo de 80% de energia ele fica
  mais lento e menos preciso; no intervalo recupera um pouco. No campo, um anel amarelo (vermelho no fim do fôlego) mostra quem está cansado. Nas simulações,
  um time descansado contra outro igual com 75% de condição vence 46% e perde 20%; com 50%, vence 61% e perde 16%. Entre dois times descansados a média de gols
  fica igual à de antes. A CPU entra sempre descansada. Elenco, escalação (e a escalação automática, que prefere quem está descansado) e a ficha mostram a condição.
- Partidas gravadas antes deste recurso continuam idênticas ao rever (o cansaço só liga quando a partida traz a condição dos jogadores).

## Lesões, cartão vermelho e suspensões
- **Cartão vermelho:** direto (raro) ou pelo segundo amarelo. O expulso sai de campo e o time fica com um a menos até o fim (goleiro não é expulso).
- **Lesões** (só em partidas entre jogadores): numa disputa de bola, quem sofre o desarme ou a falta pode se machucar; cansado se machuca mais (a
  chance chega a quase o triplo). O lesionado é trocado sozinho na primeira bola parada pelo melhor reserva da mesma função (dentro do limite de 5 trocas,
  que vale também para as planejadas); sem reserva ou sem trocas, ele joga no sacrifício. A narração avisa ("fica no chão sentindo a lesão", "substituição
  forçada"). Fica de 1 a 6 dias fora (tempo real): 55% um dia, 30% dois ou três, 15% de quatro a seis. Nas simulações, cerca de uma lesão a cada 4 jogos.
- **Treino forte** também pode machucar (2%; 8% se o jogador terminar a sessão abaixo de 35% de condição), por 1 ou 2 dias.
- **Suspensão:** vermelho ou 3 amarelos acumulados = fora do próximo jogo oficial do clube (jogo contra a CPU não conta). Os amarelos do lance da expulsão
  não acumulam.
- Lesionado não treina nem joga; suspenso não joga. Se estiver escalado, na hora do jogo entra o melhor reserva da posição (a escalação avisa, e a escalação
  automática já deixa de fora). A **fisioterapia** num lesionado também tira um dia da lesão. O aviso do fim do jogo lista quem ficou de fora, quem se
  machucou e quem foi suspenso. A ficha do clube tem a coluna de vermelhos (CV).
- Estado na tabela `player_training` (`inj_until`, `inj_kind`, `susp`, `yellows`); vermelhos em `player_stats.reds`. Partidas antigas continuam idênticas
  ao rever: as regras novas só ligam em partidas com a versão 6 das regras (`v` na definição do time). Motor: versão 6.

## Estrutura do clube (aba "Estrutura")
Três instalações compradas com o saldo, do nível 1 ao 5. Subir de nível custa € 15 M, 30 M, 60 M e 100 M (€ 205 M para levar uma instalação ao máximo).
Todo clube começa no nível 1, que equivale às regras de antes.
- **Centro de Treinamento:** o treino rende +10% por nível acima do 1 (até +40%); a partir do nível 4, cada jogador treina **3 vezes por dia**.
- **Departamento médico:** a condição física volta +1% por hora por nível (nível 5: 8% por hora, 16% em descanso); lesões duram 10% menos por nível
  e a fisioterapia fica 10% mais barata por nível (até 40%).
- **Estádio:** bilheteria em cada partida oficial jogada em casa (quem desafia é o mandante): € 2 M, 4 M, 6 M e 9 M nos níveis 2 a 5. Jogo contra a CPU não
  rende bilheteria.
- A recuperação segue o departamento médico do clube dono do jogador: ao melhorar o médico ou ao trocar de clube (compra, venda, leilão, troca) a condição
  é "congelada" no ritmo antigo, então ninguém recupera retroativamente. A ficha do clube mostra o nível de cada instalação.
- Fica na coluna `clubs.facilities` (jsonb); o reset de temporada volta tudo ao nível 1.

## Estatísticas (artilharia e assistências)
Aba **Estatísticas**: Artilharia, Assistências, Gols + assistências e Goleiros (jogos sem sofrer gol e defesas), com o clube de cada jogador.
Só contam partidas entre jogadores (a CPU é teste). Clicando num jogador abre a ficha (com as estatísticas dele por clube) e clicando num
clube abre o elenco com jogos, gols, assistências, gols+assistências, jogos sem sofrer gol e cartões **pelo clube**. Se o jogador trocar de clube,
as estatísticas ficam registradas em cada clube por onde passou. Nas ligas e copas há também a aba Assistências.
- **Assistência:** último passe de um companheiro para quem fez o gol, até 9 s antes, sem a bola ter passado pelo adversário. Gol contra não tem
  assistência (aproximadamente 65% dos gols têm). Uma assistência também sobe a nota do jogador.
- As estatísticas ficam na tabela `player_stats` (jogador + clube). Partidas jogadas antes desse recurso não entram.

## Venda, leilão e trocas justos
- **Vender ao banco** paga 75% do valor de mercado (preço fixo). **Leiloar** é a venda entre jogadores: o dono escolhe o preço inicial.
- Na tela de venda aparece a tabela de jogadores com características parecidas (mesma função, nota e habilidades próximas), o valor de
  cada um, a média e a **faixa permitida** (80% a 130% da referência, que é metade o valor do jogador e metade a média dos parecidos).
  Fora da faixa o servidor recusa. Isso impede, por exemplo, comprar jogadores em várias contas e "vender" quase de graça para a conta principal.
- Jogador **sem clube** não vai a leilão (só o dono pode leiloar, e só o que é do próprio clube): leilão não é atalho para comprar do mercado.
  Quem abriu o leilão não pode dar lance nele.
- **Trocas** precisam ser equilibradas: o que você entrega (jogadores + dinheiro) e o que recebe não podem diferir mais de 35% em valor de mercado
  (nada de "dar" um jogador caro por quase nada).
- Mesmo assim, não há como impedir por regra que uma mesma pessoa jogue com duas contas; vale ficar de olho em clubes com o mesmo técnico.

## Recomeçar a temporada
`node scripts/reset-season.js --yes` (com o servidor parado ou reiniciado logo depois) devolve todos os clubes ao saldo inicial, sem
elenco, técnico, pontos, partidas, ligas, trocas, forma nem treino/condição física. As contas são mantidas (cada técnico entra com o mesmo nome e senha e refaz o time do zero).
Faz backup em `data/backup-temporada-<data>-<hora>.json` (nunca sobrescreve um anterior). `--drop="Clube A,Clube B"` remove clubes inteiros (ex.: os de teste).
Como o servidor guarda tudo em memória, reinicie o serviço no Render logo depois (um novo deploy já reinicia).

## Dados
- Padrão: `server/seed.js` (elencos reais, valores/notas aproximados escritos à mão).
- Sofascore (opcional): `npm run sync -- "Clube=ID" ...` grava `data/catalog.sofascore.json`, que passa a ser usado.
  A API deles retorna 403 para acesso automatizado; o adaptador não contorna isso. Só funciona com acesso permitido
  (SOFASCORE_BASE / SOFASCORE_HEADERS). Confira os termos de uso do Sofascore.

## Busca de jogadores (milhares, com foto)
No Mercado, digitar 3+ letras (ex.: "Igor", "Vinicius", "Yamal") busca o nome no **Wikidata** (dados abertos, sem chave):
qualquer jogador de futebol do mundo, nacional ou internacional. Vêm foto (Wikimedia Commons), posição, clube atual,
nacionalidade, idade e altura. Os até 15 mais famosos de cada busca são guardados na tabela `imported_players` do Supabase
e passam a aparecer no mercado de todos os clubes.
- O Wikidata não tem valor de mercado nem atributos: a **nota** é estimada pela fama do jogador (edições da Wikipédia sobre
  ele) e o **valor** pela nota (mesma curva do catálogo). Fica marcado como estimado (tag "WD"). Sem clube = "Sem clube".
- Carga em massa: `node scripts/load-players.js` baixa do Wikidata os jogadores em atividade das principais ligas (Premier League,
  La Liga, Serie A, Bundesliga, Ligue 1, Brasileirão A e B, Primeira Liga, Eredivisie, Argentina, MLS, Arábia Saudita, Turquia, Escócia,
  Bélgica, México, Uruguai) e das 47 principais seleções, e grava em `imported_players` (~8 mil jogadores, alguns minutos; pode ser
  interrompido e retomado; `--refresh` atualiza os já guardados). O servidor em execução incorpora os novos a cada 5 minutos.
- Fotos: o navegador carrega direto do Wikimedia Commons; sem foto, aparece a inicial do nome.
- Sofascore: a API deles retorna 403 para servidores e o adaptador não contorna isso. Só é usado se você definir
  SOFASCORE_BASE (proxy/licença próprios) e SOFASCORE_HEADERS (JSON); aí ele substitui o Wikidata.

## Estrutura
server/ (API, regras, catálogo) · js/engine.js (partida) · js/render.js (campo) · js/game.js (cliente) · game.html
`index.html` é o widget de demonstração original.

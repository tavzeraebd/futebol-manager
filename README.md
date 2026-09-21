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

## Ligas e copas entre amigos (aba "Ligas")
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

## Leilão ao vivo e trocas (aba "Leilão e trocas")
- Qualquer jogador (ou técnico) pode ir a leilão: o dono leiloa o dele (botão "Leiloar" no Elenco) e qualquer um pode leiloar
  quem está sem clube (botão "Leilão" no Mercado). 45 s de relógio; lance nos últimos 10 s estende o tempo. Lance mínimo sobe 5% (mín. €1M).
  O vencedor paga o valor cheio ao vendedor (sem o desconto de 25% da venda ao banco). Máx. 2 leilões abertos por clube.
- O dinheiro dos lances vencendo fica reservado (não dá para dar lances acima do saldo em vários leilões) e vale a vaga do elenco.
- Trocas: escolha o clube, marque quem você dá e quem recebe (até 5 de cada lado) e, se quiser, dinheiro. O outro aceita ou recusa;
  a troca é conferida de novo ao aceitar (dono, saldo, elenco máx. 25, um técnico por clube). Itens em leilão/troca ficam travados.

## Tática e substituições (aba "Escalação")
- Estilos: Equilibrado, Ofensivo, Retranca, Contra-ataque e Pressão alta. Além disso, planeje até 5 trocas e 3 mudanças de tática
  em minutos combinados; elas acontecem na primeira bola parada depois do minuto (ou no intervalo) e são narradas.

## Jogar você mesmo (aba "Clubes")
- "Jogar (eu controlo)": contra a CPU ou contra o time de um amigo; você controla o jogador mais próximo da bola.
  W A S D ou setas mover, Q/Espaço passe (para quem está na direção que você aponta), E chute, Shift correr. No celular aparecem botões na tela.
- "2 jogadores no mesmo teclado": P1 com W A S D + Q + E + Shift; P2 com setas + K + L + Shift direito.
- É treino: não vale prêmio nem pontos e não fica no histórico.

## Login com Google (clube persistente)
Sem login, o clube fica preso ao navegador (se limpar os dados, perde o acesso). Com o Google, o clube fica ligado à sua conta.
1. Acesse https://console.cloud.google.com > crie/seleciona um projeto > "APIs e serviços" > "Tela de permissão OAuth"
   (tipo Externo; adicione seu e-mail como usuário de teste).
2. "Credenciais" > "Criar credenciais" > "ID do cliente OAuth" > tipo "Aplicativo da Web".
3. Em "Origens JavaScript autorizadas" adicione exatamente: `http://localhost:3210`
   (e a URL pública, se hospedar o jogo; a porta precisa ser a mesma).
4. Copie o ID do cliente e ponha em `config.local.json` (veja `config.example.json`) ou na variável `GOOGLE_CLIENT_ID`.
5. Reinicie o servidor (`iniciar.bat`). A tela inicial passa a mostrar o botão "Fazer login com o Google".
Clubes já criados sem login mostram o botão "Continuar com o Google" no topo para se vincularem.
O servidor valida a assinatura do token do Google (sem guardar senha); você pode entrar em vários dispositivos.

## Banco de dados (Supabase)
Tudo o que precisa persistir (clubes, elencos, partidas, ligas/copas, trocas, jogadores importados) fica no projeto Supabase
`futebol-manager`, nas tabelas `clubs`, `club_players`, `matches`, `leagues`, `league_members`, `league_fixtures`,
`trades` e `imported_players` (RLS ligado, sem policies: só o servidor acessa).
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

## Venda, leilão e trocas justos
- **Vender ao banco** paga 75% do valor de mercado (preço fixo). **Leiloar** é a venda entre jogadores: o dono escolhe o preço inicial.
- Na tela de venda aparece a tabela de jogadores com características parecidas (mesma função, nota e habilidades próximas), o valor de
  cada um, a média e a **faixa permitida** (80% a 130% da referência, que é metade o valor do jogador e metade a média dos parecidos).
  Fora da faixa o servidor recusa. Isso impede, por exemplo, comprar jogadores em várias contas e "vender" quase de graça para a conta principal.
- Jogador **sem clube** só vai a leilão a partir do preço de contratação (120% do valor): leilão não é atalho mais barato que a compra direta.
  Quem abriu o leilão não pode dar lance nele.
- **Trocas** precisam ser equilibradas: o que você entrega (jogadores + dinheiro) e o que recebe não podem diferir mais de 35% em valor de mercado
  (nada de "dar" um jogador caro por quase nada).
- Mesmo assim, não há como impedir por regra que uma mesma pessoa jogue com duas contas; vale ficar de olho em clubes com o mesmo técnico.

## Recomeçar a temporada
`node scripts/reset-season.js --yes` (com o servidor parado ou reiniciado logo depois) devolve todos os clubes ao saldo inicial, sem
elenco, técnico, pontos, partidas, ligas, trocas nem forma. As contas são mantidas. Faz backup em `data/backup-temporada-*.json`.

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

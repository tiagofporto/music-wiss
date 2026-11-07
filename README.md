# Music Wiss

Editor de partituras para a web, com identidade própria. Escreva notas pelo
teclado, veja a partitura se formar com tipografia musical profissional (SMuFL)
e ouça o resultado na hora.

## Rodando

```bash
npm install
npm run dev      # abre em http://localhost:5173
npm test         # testes do modelo, editor e sequenciador
npm run build    # gera a versão de produção em dist/
```

## Como escrever

Aperte **N** para entrar no modo de escrita e digite as letras **A–G**. A oitava
é escolhida automaticamente (a mais próxima da nota anterior) e a armadura de
clave já aplica os sustenidos/bemóis. O esquema de atalhos é próprio do Music Wiss:

| Tecla | Ação |
| --- | --- |
| `N` / `Esc` | Liga / desliga o modo de escrita |
| `A`–`G` | Escreve a nota |
| `Shift` + `A`–`G` | Acrescenta a nota ao acorde |
| `1`–`6` | Semibreve, mínima, semínima, colcheia, semicolcheia, fusa |
| `.` | Ponto de aumento |
| `0` | Pausa |
| `+` / `-` | Sustenido / bemol na nota selecionada |
| `↑` / `↓` | Sobe / desce um semitom (`Ctrl` = oitava) |
| `T` | Ligadura de prolongamento |
| `Shift` + `3` | Tercina (`Shift` + `2`, `5`, `6`, `7`, `9`: outras quiálteras) |
| `Alt` + `1`–`4` | Escreve na voz 1, 2, 3 ou 4 |
| `Alt` + `↑` / `↓` | Vai para a pauta de cima / de baixo |
| `Shift` + `←` / `→`, `Shift` + clique | Seleciona um trecho |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copia, recorta e cola |
| `Ctrl+A` | Seleciona a voz inteira |
| `←` / `→`, `Home`, `End` | Move o cursor |
| `Backspace` / `Delete` | Apaga |
| `Espaço` | Toca a partir do cursor / para |
| `Ctrl+Z` / `Ctrl+Y` | Desfaz / refaz |
| `Ctrl+K` | Paleta de comandos (busca qualquer ação pelo nome) |
| `Ctrl+S` | Salva a partitura em `.wiss.json` |
| `?` | Lista de atalhos |

Fórmula de compasso, tonalidade e instrumentos novos ficam na paleta de comandos
(`Ctrl+K`): a mudança vale a partir do compasso onde está o cursor.

A partitura é salva automaticamente no navegador.

## Início

Ao abrir o Music Wiss aparece o **Início**: saudação pelo horário (com o seu
nome, se você entrou na Nuvem), a partitura aberta numa estante em 3D sobre uma
pauta que se desenha, e três portas: **Escrever**, **Editar** e **Tocar**.
Embaixo: **Continue de onde parou** (partituras recentes), **Próximo evento**
(abre direto no palco, com "hoje", "amanhã" ou "em N dias") e **Documentos**.
O logo no topo volta para o Início. Recarregar a página na mesma aba do
navegador mantém você onde estava.

## Minhas partituras

Botão **Partituras** no topo (ou Ctrl+Shift+O, ou Arquivo → Minhas
partituras). Toda partitura criada, aberta de um arquivo ou vinda da nuvem fica
guardada neste navegador e é salva sozinha enquanto você escreve (partituras
novas ainda vazias e sem título não entram).

- Lista com título, compositor, instrumentos, compassos e quando foi editada;
  a aberta aparece marcada. Busca por título ou compositor (sem acento).
- **Abrir**, **fazer uma cópia** e **apagar** (com confirmação e **Desfazer**
  logo em seguida). Apagar a partitura aberta abre a mais recente.
- Os PDFs e fotos abertos aparecem na mesma tela e também podem ser apagados
  (as marcações vão junto; o arquivo original no aparelho não muda).
- As partituras da sua conta continuam em **Nuvem**, onde também dá para apagar.

## Na conta e no Google Drive

Minhas partituras tem três abas: **Neste aparelho**, **Na sua conta** e
**Google Drive**.

- **Na sua conta**: com login na Nuvem, cada partitura pode ir para o seu
  perfil (tabela `scores` no Supabase, protegida por RLS). Toque em ☁ numa
  partitura do aparelho, ou em **Salvar na conta**. Enquanto está aberta, ela
  salva sozinha e abre em qualquer aparelho com a mesma conta.
- **Google Drive**: **Salvar no Google Drive** (menu Arquivo ou a biblioteca)
  grava `Título.wiss.json` na pasta **Music Wiss** do seu Drive; também dá para
  salvar em MusicXML ou PDF. Salvar de novo atualiza o mesmo arquivo, e se ele
  mudou no Drive o app pergunta antes de substituir. **Abrir do Google Drive**
  (menu Arquivo, Editar e Tocar) abre o seletor do Google e leva o arquivo para
  a aba certa.
- O Drive usa o escopo `drive.file`: o app só vê o que ele salvou ou o que
  você escolheu. O token fica só na memória. Configure
  `VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_API_KEY` e `VITE_GOOGLE_APP_ID` (ver
  `.env.example`) ou cole os valores na aba Google Drive. Na versão de teste
  (artifact) o Google não carrega; use o app publicado.

## Abrir e exportar

No menu **Arquivo** (ou `Ctrl+O`, arrastando o arquivo para a janela, ou pela paleta):

| Formato | Abrir | Exportar | Observações |
| --- | --- | --- | --- |
| `.wiss.json` | ✓ | ✓ | Formato nativo, sem perdas |
| MusicXML (`.musicxml`, `.xml`, `.mxl`) | ✓ | ✓ | Notas, acordes, até 4 vozes, 2 pautas por instrumento, ligaduras, quiálteras, mudanças de compasso/tom, andamento, transposição, dinâmicas, articulações, letra (1ª estrofe), cifras, repetições e casas. O que o editor ainda não tem (apojaturas, ligaduras de expressão, crescendos) é ignorado na importação, com aviso |
| MIDI (`.mid`) | | ✓ | Formato 1, uma trilha por instrumento, com programa General MIDI, volume, andamento, fórmulas de compasso, dinâmicas e repetições desdobradas |
| PDF | | ✓ | A4, título na 1ª página, sistemas sem corte entre páginas, numeração |

## Expressão, texto e repetições

O botão **mais** na barra de baixo abre o painel de expressão (também tem tudo na paleta, `Ctrl+K`):

- **Dinâmicas** (ppp a fff, fp, sfz): valem da nota selecionada em diante e mudam a intensidade na reprodução e no MIDI.
- **Articulações:** staccato (`S`), staccatissimo (`Shift+S`), acento (`V`), marcato (`Shift+V`), tenuto (`U`) e fermata. Staccato encurta a nota tocada; acento e marcato reforçam.
- **Letra** (`L`): abre uma caixa embaixo da nota. `Espaço` vai para a próxima nota, `-` separa sílabas (com hífen desenhado entre elas), `Enter` termina.
- **Cifras** (`H`): texto livre como `Am7`, `Bbmaj7/D`, `F#m7b5`, mostrado com ♭/♯. `Espaço` vai para o próximo evento.
- **Repetições:** início e fim de repetição e casas de 1ª e 2ª vez no compasso da nota selecionada. A reprodução e o MIDI tocam a música desdobrada.

Tudo isso vai e volta pelo MusicXML (`<dynamics>`, `<articulations>`, `<lyric>`, `<harmony>`, `<repeat>`, `<ending>`).

## Metrônomo (abas Escrever e Editar)

Botão do metrônomo no topo, ou **Ctrl+Shift+M**. O painel fica aberto ao lado da partitura:

- **Andamento** de 30 a 240 batidas por minuto: botões −/+ (de 5 em 5), barra deslizante ou **Toque no ritmo** (toque 4 vezes ou mais). Mostra quanto é da partitura (ex.: 80%) e **Voltar ao original**. O andamento de estudo não muda a partitura.
- **Padrões**: Tempos, Só o 1º, Colcheias, Tercinas, Semicolcheias e Contratempo. O 1º tempo é mais forte; em 6/8, 9/8 e 12/8 o clique segue a semínima pontuada.
- **Volume** próprio do metrônomo, separado dos instrumentos.
- **Praticar a leitura**: conta um compasso antes (número grande na tela) e o cursor anda nota a nota junto com o clique, a partir de onde ele está. Desligue "Tocar as notas da partitura" para ouvir só os cliques e tocar você mesmo.
- **Junto com Ouvir**: os cliques tocam sempre que você aperta Ouvir (Espaço).
- **Só o metrônomo**: clique contínuo na fórmula de compasso do cursor.
- **Na aba Editar** (PDF e fotos): o mesmo painel, com escolha do compasso (2/4 a 12/8) e andamento próprios. **Começar a ler** conta um compasso e depois mostra o número do compasso em que você está.

Os cliques seguem as mudanças de compasso e as repetições da partitura. As preferências ficam salvas no aparelho. A lógica está em `src/audio/metronome.ts`, com testes em `tests/metronome.test.ts`.

## Som e teclado MIDI

O botão **Som** abre o painel de áudio:

- **Volumes:** volume geral e, para cada instrumento, volume e mudo (salvos na partitura).
- **Instrumentos:** sem nada carregado, o editor toca com timbres sintetizados, um por família General MIDI (piano, órgão, cordas, metais, palhetas, flautas, coro, cordas dedilhadas…). Para som de instrumentos gravados, carregue um **SoundFont** (`.sf2` ou `.sf3`, como o GeneralUser GS ou o FluidR3_GM). O arquivo é lido no próprio navegador (zonas por nota e intensidade, afinação, laço, envelope, filtro e pan) e fica guardado para as próximas visitas.
- **Teclado MIDI:** conecta pelo Web MIDI (Chrome, Edge, Opera). Cada tecla soa na hora com o instrumento atual e a intensidade tocada. No modo de escrita (`N`) a tecla vira nota com a figura escolhida; teclas apertadas juntas viram um acorde, e uma tecla somada enquanto o acorde ainda está seguro entra nele. A grafia segue a tonalidade (Fá# em Sol maior, Sol♭ em tons de bemol) e instrumentos transpositores recebem a nota escrita.

## Abrir MIDI, PDF e fotos; marcar por cima

- **MIDI (.mid)**: Arquivo → Abrir. Vira partitura editável e toca com Espaço.
  Cada trilha vira um instrumento (piano e órgão em duas pautas). Os tempos
  são arredondados para semicolcheias, e notas que se sobrepõem vão para a 2ª voz.
  A percussão (canal 10) ainda fica de fora.
- **PDF ou foto (JPG/PNG)**: abre o documento para ler e marcar. As marcações
  ficam guardadas neste navegador (Arquivo → Documentos recentes), e
  "Baixar com marcações" gera um PDF novo com tudo desenhado.
- **Marcar a partitura**: botão **Marcar** (ou tecla M). As ferramentas são
  mover, caneta, marca-texto, texto, selo e borracha, em 5 cores. Cada traço
  desfaz com Ctrl+Z. As marcações são salvas com a partitura (arquivo e nuvem).
  - **Selos**: setas, formas (círculo, quadrado...) e notas musicais na cor
    escolhida, mais emojis de atenção (⚠️ ❗ ⭐ 👀 🎵...).
  - **Mover**: arraste qualquer marcação. Com ela selecionada: A−/A+ (ou −/+)
    mudam o tamanho, as cores trocam a cor, Delete apaga e as setas ajustam.
    Duplo clique num texto corrige o texto.
  - **Lugar da barra**: no topo (padrão), à esquerda, à direita ou embaixo
    (botão de layout na barra). A escolha fica guardada.
  - **Limpar tudo** pergunta antes, diz quantas marcações serão apagadas e
    pode ser desfeito.
  - Ao voltar, o app reabre o documento que estava aberto no ponto em que você
    parou, e o modo de marcação continua ligado se estava.
- **Ler e analisar com IA** (precisa da nuvem): a IA lê até 4 páginas por vez
  e transcreve as notas. Também aponta o que conferir e sugere edições. A
  partitura transcrita abre editável e toca. Compassos que não fecham são
  completados com pausas e avisados.

## Aba Editar (PDF e fotos)

No topo ficam três abas: **Escrever** (o editor de notas), **Editar** e
**Tocar**. A aba **Editar** (Ctrl+Shift+E) é onde se trabalha em cima de uma
partitura que já existe em PDF ou foto:

- **Carregar PDF ou foto** (clicar, arrastar ou Ctrl+O). Um PDF aberto pelo
  menu Arquivo em Escrever também vem para cá.
- Marcar com caneta, marca-texto, texto, selos e borracha; mover e corrigir
  depois; a barra pode ficar no topo, nos lados ou embaixo.
- **Ler e analisar com IA** transforma as notas em partitura editável, que
  abre em Escrever.
- **Baixar com marcações** gera o PDF marcado.
- **Fechar documento** volta para a lista **Seus documentos**, com abrir e
  apagar. Trocar de aba e voltar reabre o documento onde você parou, e
  recarregar a página também.

## Aba Tocar (palco)

No topo há duas abas: **Escrever** (o editor) e **Tocar**, para ler e tocar
a partitura sem distrações. O botão que toca o som agora se chama **Ouvir**.

- **Partitura limpa**: sem barra de escrita, cursor ou avisos; as marcações à
  mão aparecem, só para ver.
- **Tela cheia** (botão ou F): esconde tudo menos a partitura. Mexer o mouse
  ou tocar na tela mostra uma barra pequena (zoom, ouvir, anterior/próxima,
  sair). Esc sai. No iPhone, onde o navegador não deixa tela cheia, a página
  esconde as próprias barras.
- **Zoom**: −, + e o número do meio (ajustar à largura). Também com as teclas
  + − 0 ou Ctrl + roda do mouse. O zoom escolhido fica guardado.
- **Virar página**: setas, PgDn/PgUp (pedais bluetooth de virar página mandam
  essas teclas). No fim da partitura, avança para a próxima do evento.
- **Carregar**: abre no palco qualquer partitura do aparelho (PDF, foto,
  MusicXML, MIDI ou .wiss.json), não só as criadas aqui. Pode escolher vários
  arquivos de uma vez e passar com ‹ ›; arrastar um arquivo para a página
  também funciona. PDF e foto aparecem como estão, com as marcações feitas em
  Escrever; MusicXML e MIDI viram partitura e dá para ouvir.
- **Eventos**: crie um evento (nome, data, local) e adicione as partituras do
  repertório (as abertas ou **Carregar arquivos**, direto do aparelho). Uma cópia de cada partitura fica salva no aparelho e funciona
  sem internet; abra com um toque, reordene, tire, ou use **Atualizar** depois
  de editar. Os próximos eventos aparecem primeiro. **Editar** leva a
  partitura do evento para a aba Escrever.
- **WhatsApp**: gera o PDF. No celular abre o compartilhar do sistema com o
  PDF anexado (escolha o WhatsApp). No computador o PDF é baixado e o WhatsApp
  abre com a mensagem pronta; é só anexar o arquivo. Se a partitura está na
  sua nuvem, o link para ver vai junto.
- **Sugestão** (balão): nota de 1 a 5 e texto. Conectado, vai para a tabela
  `feedback` (só inserir; ninguém lê pelo app). Sem conta, fica guardada no
  aparelho e é enviada quando a pessoa entrar.

## Nuvem, compartilhamento e assistente

Projeto de produção: **music-wiss** (Supabase, São Paulo), já com as migrações
aplicadas e a função `assistente` publicada. O build de produção lê a URL e a
chave publicável de `.env.production`. Para o assistente responder, defina o
segredo `ANTHROPIC_API_KEY` em Edge Functions > Secrets no painel do Supabase.

O botão **Nuvem** liga o editor a um projeto [Supabase](https://supabase.com):

- **Conta** com e-mail e senha.
- **Minhas partituras**: salvar na nuvem, abrir em outro computador, apagar.
  Depois de salva, cada mudança é gravada sozinha (1,5 s depois da última edição).
- **Compartilhar por link**: "Link para ver" ou "Link para editar". Quem abre o
  link entra na conta e a partitura aparece em "Compartilhadas comigo".
  "Desativar links" impede novas entradas.
- **Tempo real**: quem está com a mesma partitura aberta vê as mudanças dos outros
  e quantas pessoas estão online. Se duas pessoas salvam ao mesmo tempo, fica a
  versão que chegou primeiro e a outra pessoa recebe um aviso; Ctrl+Z traz a
  versão dela de volta.

O botão **Assistente** (precisa estar conectado) usa IA no servidor:

- **Harmonizar**: sugere cifras para a voz onde está o cursor, no estilo pedido.
  Você vê a lista antes e aplica com um clique (Ctrl+Z desfaz tudo).
- **Revisar**: aponta notas fora da extensão, saltos difíceis, compassos
  incompletos e grafias estranhas.

### Como ligar

1. Crie um projeto no Supabase e rode `supabase/migrations/*.sql`
   (`supabase db push` ou cole no SQL Editor). Isso cria as tabelas, as regras
   de acesso (RLS) e liga o tempo real.
2. Publique a função do assistente e guarde a chave da API da Anthropic
   **só no servidor**:
   ```
   supabase functions deploy assistente
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   ```
3. Copie `.env.example` para `.env.local` e preencha a URL e a chave
   **publicável** do projeto. Sem isso, dá para colar as duas no próprio painel
   Nuvem (ficam guardadas no navegador).

O que fica no banco: `scores` (a partitura em JSON e um número de versão),
`score_shares` (os links) e `score_members` (quem entrou por link e com que
papel). Só o dono apaga a partitura e cria links; quem tem link de edição pode
salvar; quem tem link de leitura só abre.

## Visual

Identidade "sala de concerto": palco azul-noite com luz de refletor, a
partitura iluminada na estante e destaques em latão (o metal dos
instrumentos). Fontes: Bricolage Grotesque (títulos da interface), Manrope
(texto) e Fraunces (título dentro da partitura, como na gravura musical).

- Movimento com propósito: a folha entra na estante em 3D ao abrir ou trocar
  de aba; o marcador das abas (com as cinco linhas da pauta) desliza; diálogos
  sobem com profundidade; o botão Ouvir pulsa enquanto toca.
- Aba Editar: pilha de folhas marcadas em 3D que acompanha o mouse.
- Quem pede menos movimento no sistema (prefers-reduced-motion) recebe tudo
  parado.
- Tema claro e escuro com as mesmas cores-base (tokens no topo de
  `src/ui/style.css`).

## Arquitetura

```
src/
  model/      Modelo de dados puro (sem DOM), 100% testável
    fraction.ts    Frações exatas para durações (sem erro de ponto flutuante)
    pitch.ts       Altura = letra + acidente + oitava; posição na pauta por grau diatônico
    key.ts         Armaduras de clave
    duration.ts    Figuras, pontos e decomposição de durações
    score.ts       Score → Part → Staff → Measure → Voice → Chord/Rest → Note,
                   instrumentos e mudanças de compasso/tonalidade no meio da música
    sequence.ts    Distribui as notas pelos compassos (ligaduras na barra, quiálteras
                   inteiras) e mantém todas as pautas com o mesmo número de compassos
    validation.ts  Validação de compassos (vazio, incompleto, completo, excedido)
    chords.ts      Cifras: leitura (fundamental, tipo, baixo) para MusicXML e exibição
  editor/     Comandos de edição, cursor, desfazer/refazer
  render/     Layout da página (largura dos compassos, quebra de linha, justificação)
              + desenho com VexFlow e fonte SMuFL Bravura
  audio/      Sequenciador (partitura → notas no tempo), motor de som com volumes por
              instrumento, timbres internos e leitor/tocador de SoundFont (SF2/SF3)
  input/      Teclado MIDI (Web MIDI, agrupamento de acordes)
  io/         MusicXML (exportar/importar, .mxl), MIDI (exportar/importar) e PDF
  cloud/      Conta, partituras na nuvem, links e tempo real (Supabase, carregado sob demanda)
  ai/         Resumo da partitura para o assistente e leitura da transcrição da IA
  annotate/   Marcações à mão (caneta, marca-texto, texto, borracha)
  library/    Minhas partituras: biblioteca local (IndexedDB) com busca, cópia e apagar
  perform/    Aba Tocar: eventos (repertórios no IndexedDB) e envio do PDF pelo WhatsApp
  doc/        PDF (pdf.js, sob demanda) e fotos: páginas, documentos guardados, exportar
  ui/         Estilos, ícones e atalhos
  main.ts     Tela: folha, barra flutuante, paleta de comandos, diálogos
```

Fora do `src/`: `supabase/migrations` (banco e regras de acesso) e
`supabase/functions/assistente` (função que chama a IA).

### Decisões importantes

- **Altura escrita, não só MIDI.** Dó♯ e Ré♭ soam igual mas são notas diferentes.
  Guardamos `step + alter + octave`; o MIDI é derivado. A posição vertical vem
  do grau diatônico, por isso Dó e Dó♯ ficam na mesma linha.
- **Frações, não floats.** Toda duração é uma fração da semibreve. Validar um
  compasso é comparar frações exatas.
- **Compassos reais.** O editor trabalha com uma sequência lógica de notas;
  `sequence.ts` distribui essa sequência nos compassos, dividindo em notas
  ligadas o que cruza a barra (e reagrupando quando você edita antes).
- **Quiálteras nunca se dividem.** Uma tercina é um grupo atômico. Ao criar,
  entram pausas provisórias que as próximas notas substituem; se uma edição
  empurra o grupo para além da barra, o resto do compasso recebe pausas de
  preenchimento, que somem sozinhas quando deixam de ser necessárias.
- **Pautas e vozes andam juntas no tempo.** Trocar de pauta ou de voz mantém o
  momento do cursor; se a voz de destino é mais curta, ela recebe pausas
  provisórias, removidas se você sair sem escrever nada.
- **VexFlow para os glifos.** Hastes, colchetes, barras de colcheia e acidentes
  com a fonte Bravura (SMuFL). O layout da página é nosso. O Verovio fica como
  opção futura para importar/gravar MusicXML com layout de gravura.

## Próximos passos

- Fase 2: ~~importar/exportar MusicXML, exportar MIDI e PDF~~ (feito); importar MIDI fica para depois.
- Fase 3: ~~som com soundfonts (SF2/SF3), volumes por instrumento e entrada por teclado MIDI~~ (feito). Escrita em tempo real (tocando junto com o metrônomo) fica para depois.
- Fase 4: ~~dinâmicas, articulações, letra, cifras e barras de repetição~~ (feito). Depois: crescendo/diminuendo, ligaduras de expressão, D.C./D.S./Coda e várias estrofes.
- Fase 5: ~~contas, nuvem, compartilhamento, colaboração e assistente com IA~~ (feito). Depois: edição simultânea nota a nota (hoje a sincronização é da partitura inteira), histórico de versões e comentários.
- Fase 6: ~~abrir MIDI e PDF/fotos, marcações por cima e leitura com IA~~ (feito). Depois: percussão no MIDI, tercinas detectadas no MIDI e marcações presas às notas (hoje ficam na posição da página).

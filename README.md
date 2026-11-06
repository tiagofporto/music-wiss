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

## Abrir e exportar

No menu **Arquivo** (ou `Ctrl+O`, arrastando o arquivo para a janela, ou pela paleta):

| Formato | Abrir | Exportar | Observações |
| --- | --- | --- | --- |
| `.wiss.json` | ✓ | ✓ | Formato nativo, sem perdas |
| MusicXML (`.musicxml`, `.xml`, `.mxl`) | ✓ | ✓ | Notas, acordes, até 4 vozes, 2 pautas por instrumento, ligaduras, quiálteras, mudanças de compasso/tom, andamento e transposição. O que o editor ainda não tem (dinâmicas, letra, articulações) é ignorado na importação, com aviso |
| MIDI (`.mid`) | | ✓ | Formato 1, uma trilha por instrumento, com programa General MIDI, andamento e fórmulas de compasso |
| PDF | | ✓ | A4, título na 1ª página, sistemas sem corte entre páginas, numeração |

## Som e teclado MIDI

O botão **Som** abre o painel de áudio:

- **Volumes:** volume geral e, para cada instrumento, volume e mudo (salvos na partitura).
- **Instrumentos:** sem nada carregado, o editor toca com timbres sintetizados, um por família General MIDI (piano, órgão, cordas, metais, palhetas, flautas, coro, cordas dedilhadas…). Para som de instrumentos gravados, carregue um **SoundFont** (`.sf2` ou `.sf3`, como o GeneralUser GS ou o FluidR3_GM). O arquivo é lido no próprio navegador (zonas por nota e intensidade, afinação, laço, envelope, filtro e pan) e fica guardado para as próximas visitas.
- **Teclado MIDI:** conecta pelo Web MIDI (Chrome, Edge, Opera). Cada tecla soa na hora com o instrumento atual e a intensidade tocada. No modo de escrita (`N`) a tecla vira nota com a figura escolhida; teclas apertadas juntas viram um acorde, e uma tecla somada enquanto o acorde ainda está seguro entra nele. A grafia segue a tonalidade (Fá# em Sol maior, Sol♭ em tons de bemol) e instrumentos transpositores recebem a nota escrita.

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
  editor/     Comandos de edição, cursor, desfazer/refazer
  render/     Layout da página (largura dos compassos, quebra de linha, justificação)
              + desenho com VexFlow e fonte SMuFL Bravura
  audio/      Sequenciador (partitura → notas no tempo), motor de som com volumes por
              instrumento, timbres internos e leitor/tocador de SoundFont (SF2/SF3)
  input/      Teclado MIDI (Web MIDI, agrupamento de acordes)
  io/         MusicXML (exportar/importar, .mxl), MIDI e PDF
  ui/         Estilos, ícones e atalhos
  main.ts     Tela: folha, barra flutuante, paleta de comandos, diálogos
```

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
- Fase 4: dinâmicas, articulações, letra, cifras e barras de repetição.
- Fase 5: contas, nuvem, compartilhamento, colaboração e assistência com IA.

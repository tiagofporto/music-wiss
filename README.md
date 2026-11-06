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
| `←` / `→`, `Home`, `End` | Move o cursor |
| `Backspace` / `Delete` | Apaga |
| `Espaço` | Toca a partir do cursor / para |
| `Ctrl+Z` / `Ctrl+Y` | Desfaz / refaz |
| `Ctrl+K` | Paleta de comandos (busca qualquer ação pelo nome) |
| `Ctrl+S` | Salva a partitura em `.wiss.json` |
| `?` | Lista de atalhos |

A partitura é salva automaticamente no navegador.

## Arquitetura

```
src/
  model/      Modelo de dados puro (sem DOM), 100% testável
    fraction.ts    Frações exatas para durações (sem erro de ponto flutuante)
    pitch.ts       Altura = letra + acidente + oitava; posição na pauta por grau diatônico
    key.ts         Armaduras de clave
    duration.ts    Figuras, pontos e decomposição de durações
    score.ts       Score → Part → Staff → Measure → Voice → Chord/Rest → Note
    sequence.ts    Distribui as notas pelos compassos, dividindo com ligaduras na barra
    validation.ts  Validação de compassos (vazio, incompleto, completo, excedido)
  editor/     Comandos de edição, cursor, desfazer/refazer
  render/     Layout da página (largura dos compassos, quebra de linha, justificação)
              + desenho com VexFlow e fonte SMuFL Bravura
  audio/      Sequenciador (partitura → notas no tempo) e sintetizador Web Audio
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
- **VexFlow para os glifos.** Hastes, colchetes, barras de colcheia e acidentes
  com a fonte Bravura (SMuFL). O layout da página é nosso. O Verovio fica como
  opção futura para importar/gravar MusicXML com layout de gravura.

## Próximos passos

- Importar/exportar MusicXML e MIDI; exportar PDF.
- Várias pautas e instrumentos (piano com 2 pautas, grade de orquestra).
- Vozes 2–4, quiálteras, dinâmicas, articulações, letra e cifras.
- Som com soundfonts (SF2/SF3) e entrada por teclado MIDI (Web MIDI).

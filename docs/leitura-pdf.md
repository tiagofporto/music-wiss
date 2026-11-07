# Ler partitura em PDF e tocar com metrônomo

Na aba **Editar**, abra um PDF ou uma foto de partitura e clique em **Ler e tocar com metrônomo**.
O app lê a partitura no próprio navegador e mostra o que reconheceu para você conferir.
Depois de confirmar, toca o metrônomo seguindo os compassos e destaca na página o compasso que está tocando.

## Como usar

1. **Analisar a partitura**: cada página é lida (até 40 páginas por vez).
2. **Revisar**: o painel mostra o tipo do documento, quantos compassos achou, a fórmula de compasso e o andamento inicial, cada um com a origem: "lido no PDF", "estimado" ou "não identificado".
   - Os compassos aparecem numerados por cima da página. Os amarelos precisam de atenção.
   - Toque num compasso para ver o que foi lido. Ali você pode:
     - mudar os tempos dele (anacruse ou compasso irregular);
     - marcar mudança de fórmula ou de andamento;
     - juntar com o próximo ou dividir em dois;
     - marcar como "não é compasso".
   - Sem fórmula de compasso e andamento inicial, o botão **Confirmar e tocar** não deixa começar.
3. **Tocar**:
   - Controles: tocar/pausar (também com a barra de espaço), parar, volume, contagem de um compasso e tipo de clique.
   - **Seguir a partitura** respeita as mudanças de andamento escritas, com velocidade de 25% a 200%. **BPM fixo** ignora essas mudanças.
   - Toque num compasso da página para começar dali.

A leitura revisada fica guardada junto com o documento. Ao reabrir o mesmo PDF, ela volta.

## O que é reconhecido

| Item | PDF digital | Escaneado / foto |
|---|---|---|
| Pautas, sistemas, barras de compasso | sim (pela imagem) | sim (pela imagem) |
| Notas (altura) e pausas (duração) | sim, quando o PDF usa fonte musical SMuFL (MuseScore 4, Dorico, Music Wiss, VexFlow…) | só a contagem de cabeças de nota pretas |
| Fórmula de compasso e mudanças | sim (texto/símbolos) | não, informe na revisão |
| Andamento inicial e mudanças (♩ = 92, Allegro, a tempo, Tempo I) | sim | só se o PDF tiver texto de verdade |
| rit., rall., accel., fermata, rubato | detectados e destacados (o clique não acompanha) | não |
| Anacruse e compasso irregular | pela soma das figuras e pela largura | pela largura e contagem de notas |
| Quiálteras | detectadas e destacadas (a soma não é conferida) | não |

O app nunca inventa valores. Quando algo não é identificado, ele avisa: "não identificado" na revisão, aviso no compasso, ou bloqueio antes de tocar.

### Limitações conhecidas

- **Página torta ou borrada**: com mais de ~1° de inclinação, as linhas da pauta deixam de ser achadas. Pautas com espaço menor que 4 px (foto de longe) também falham.
- **Notas pretas com viga** (colcheias ligadas): a duração não vem como símbolo. A soma do compasso fica como "no máximo", sem acusar erro.
- **Repetições, casas 1 e 2, D.C. e D.S.** não são seguidas: os compassos tocam na ordem em que aparecem.
- **Barras**: uma haste que atravessa a pauta inteira pode virar barra falsa. Quando o app desconfia, o compasso fica marcado para conferir.

## Arquitetura

Reaproveita o que já existia no app:

- **pdf.js** (`pdfjs-dist`) abre e desenha o PDF. Também fornece o texto e a lista de desenhos da página, usada para separar página digital de escaneada.
- `src/doc/document.ts`: limites de tamanho e mensagens de erro (PDF com senha, inválido, grande demais).
- **Web Audio**: o clique é o `AudioEngine.click`, o mesmo do metrônomo, no bus `__metro` com volume próprio.
- `src/audio/metronome.ts` cuida dos tempos e padrões, inclusive compassos compostos.

Módulos novos, em `src/reading/`:

| Arquivo | O que faz |
|---|---|
| `raster.ts` | OMR estrutural em JavaScript puro: binarização (Otsu), linhas da pauta, sistemas, barras (descarta hastes e fórmulas) e cabeças de nota pretas. |
| `text.ts` | andamentos e fórmulas no texto do PDF. |
| `glyphs.ts` | notas, acordes, pausas, pontos, bandeirolas, claves e armadura a partir dos símbolos SMuFL. |
| `model.ts` | o mapa de leitura (JSON guardado com o documento), os avisos, as correções (juntar, dividir, ignorar) e os cliques de cada compasso (andamento seguido ou fixo, anacruse). |
| `analyze.ts` | desenha cada página num canvas e junta tudo. |
| `ui.ts` | painel de revisão e de tocar, e as caixas dos compassos sobre a página. |

## Bibliotecas, serviços e custos

| Opção | Custo | Situação |
|---|---|---|
| Leitura no navegador (este recurso) | **grátis**, nenhum arquivo sai do aparelho | usada |
| pdf.js (Mozilla, Apache 2.0) | grátis | já era usado |
| Audiveris (OMR completo, código aberto AGPL) | grátis, mas precisa de um servidor Java próprio. A versão desktop exporta MusicXML, que o app já abre em Escrever | sugestão para notas e durações completas em scans |
| Tesseract.js (OCR de texto) | grátis, porém ~10 MB a mais no app | não usado: só serviria para ler "♩ = 92" em scans, e a pessoa digita isso na revisão |
| IA (Claude lendo a imagem), já existente em "Ler e analisar com IA" | pago por uso na API da Anthropic | **desligada** por decisão do projeto |

## Testes

```
npm test
```

| Arquivo | Cobre |
|---|---|
| `tests/reading-raster.test.ts` | pautas, barras sem confundir hastes, piano em um sistema, anacruse, binarização, página sem música (com páginas desenhadas no teste) |
| `tests/reading-model.test.ts` | metrônomo escrito de várias formas, palavras de andamento, rit./a tempo, fórmulas, PDF digital × escaneado, mudanças de andamento e de compasso, juntar/dividir, cliques e duração (andamento seguido, fixo, velocidade, anacruse, 6/8) |
| `tests/reading-glyphs.test.ts` | nomes de notas, acordes, pontos, bandeirolas, pausas, armadura, mensagens de erro de PDF |

No navegador, o fluxo completo foi testado com Playwright:

- PDF com senha e PDF quebrado mostram mensagens claras;
- PDF digital vetorial;
- PDF exportado como imagem;
- revisão e correção;
- tocar, pausar, parar e trocar para BPM fixo;
- reabrir o documento;
- celular a 390 px.

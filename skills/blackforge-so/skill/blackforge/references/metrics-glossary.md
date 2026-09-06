# BlackForge metrics glossary

Every column BlackForge returns is a **measurement of the order book or trade tape** over one
closed 5-minute window for one `(exchange, symbol)`. There are **120 catalog metrics**, and a full
row on the top tier carries all 120 — keys, quote/USD conversion fields and quality markers
included. (The ClickHouse table has 122 physical columns; `bookAgeTime` and `seedDepth` are
`internal: true`, measure our own collector rather than the market, and are never sold.) Describe
each column to the user using the measurement wording below — never as a score, a call, or an event
to act on.

**How to use this file.** Pick the `metric key` that matches what the user asked for and pass it
verbatim to `blackforge_series` (or `blackforge_latest`'s `columns`). Always reconcile against the
live `blackforge_catalog` output — plans, units and wording there are canonical; this table is a
fast index. `min plan` tells you the lowest tier that includes the column: if the caller's key is
below it the column comes back empty with an `X-BlackForge-Columns-Omitted` note (see SKILL.md).

**Units.** `quote` = the pair's quote currency (multiply by `quoteUsdRate` for USD); `base` = the
base coin; `price` = quote per base; `ms` = milliseconds; `seconds` = seconds (not ms — check the
unit before converting); `percent` = percent, already ×100, not a 0–1 ratio;
`count`/`index`/`ratio`/`bool`/`usd` as named. Those eleven are the whole set the API returns.
Columns marked quote-relative are raw in the quote currency.

**Families at a glance.** keys (4) · candle (4, price OHLC) · tradeFlow (10, taker buy/sell
aggression) · bookWalls (14, cumulative resting depth within a % band of top-of-book, plus how far
the book reaches) · orderLadders (14, resting depth in fixed 3%-wide slices) · bookMicro (11,
liquidity added and removed, level counts, level flicker, level lifetime) · tradeTiming (8,
silences, repeating intervals, same-size / same-instant groupings) · strong (19, counts and value
of outsized trades at size multiples) · enrichment (18, market-cap, rank, per-pair
CoinMarketCap liquidity/volume, plus the attention and developer-activity block) · context (9, BTC/ETH reference
prices, fear-and-greed, exchange app-store ranks, market-wide news rate) · quality (11 physical,
**9 sold** — the two internal ones are excluded).

> **The depth-band names are PERCENT, not basis points.** `upDepth30` is +30%, `upDepth400` is
> +400%, `downDepth5` is −5%. An earlier audit read them as bps and built a wrong conclusion on it.
> Asks use wide bands (+30…+400%) because alt asks are sparse; bids use tight ones (−5…−20%)
> because support sits near price.

> **bookWalls vs orderLadders.** A *wall* is cumulative depth from top-of-book out to a band edge
> (e.g. `upDepth100` = all resting asks up to +100%). A *ladder* rung is the depth inside one
> discrete 3% slice (e.g. `buyOrderVol6` = bids 3–6% below top). Walls measure total thickness;
> ladder rungs measure how that depth is distributed across price.

> **Read `qualityFlags` on every row.** It is free on every plan, deliberately queryable, and it is
> what qualifies every other column. `0` means no known problem; each set bit names one condition
> and carries a `contaminates` list. The `QUALITY_UNKNOWN` flag (mask 32768) means the row predates
> the quality rail — **unchecked, not unreliable**. Where a chart draws this: wherever the mark is fainter or hollow,
> that bucket is flagged; solid means final.

> **Five columns you must not request.** `bookSynced`, `missingTrades`, `quoteAsset`, `baseAsset`
> and `enrichmentTs` are **non-queryable**: naming any one in `columns=` returns a 400 for the whole
> request, the columns you actually wanted included. Nothing in the catalog marks them — all five
> are served at `minPlan: free`, and `plottable: false` is not the tell (`qualityFlags` and
> `bookObservedAt` are also `plottable: false` and both ARE queryable). They arrive on their own in
> a full row; just never ask for them by name. `qualityFlags` replaces the `bookSynced` and
> `missingTrades` concerns.
>
> `bookAgeTime` and `seedDepth` are the opposite case: internal, and deliberately
> **accepted-and-ignored** in `columns=` — harmless there, though they do 400 a `series` call.

## Keys & timestamps  
_family key: `keys` · 4 metrics_

| metric key | label | unit | min plan | measurement |
|---|---|---|---|---|
| `exchange` | Exchange | index | free | The exchange the snapshot came from. |
| `symbol` | Symbol | index | free | The trading pair the snapshot describes. |
| `ts` | Snapshot time | ms | free | The time the 5-minute window closed. |
| `ingestedAt` | Ingested time | ms | free | The time the snapshot was written to storage. |

## Candle (price)  
_family key: `candle` · 4 metrics_

| metric key | label | unit | min plan | measurement |
|---|---|---|---|---|
| `priceOpen` | Open price | price | free | The price at the start of the window. |
| `priceHigh` | High price | price | free | The highest price reached during the window. |
| `priceLow` | Low price | price | free | The lowest price reached during the window. |
| `price` | Close price | price | free | The last price of the window. |

## Trade flow (taker aggression)  
_family key: `tradeFlow` · 10 metrics_

| metric key | label | unit | min plan | measurement |
|---|---|---|---|---|
| `buyTradeVol` | Buy trade volume | quote | free | Total value of taker-buy trades in the window. |
| `sellTradeVol` | Sell trade volume | quote | free | Total value of taker-sell trades in the window. |
| `buyTradeCount` | Buy trade count | count | free | Number of taker-buy trades in the window. |
| `sellTradeCount` | Sell trade count | count | free | Number of taker-sell trades in the window. |
| `buyTradePriceAvg` | Buy trade average price | price | free | Plain average price of taker-buy trades in the window. |
| `sellTradePriceAvg` | Sell trade average price | price | free | Plain average price of taker-sell trades in the window. |
| `buyTradeSizeAvg` | Buy trade average size | base | free | Average size of taker-buy trades in base coin units. |
| `sellTradeSizeAvg` | Sell trade average size | base | free | Average size of taker-sell trades in base coin units. |
| `buyTradeMax` | Largest buy trade | quote | free | Value of the single largest taker-buy trade in the window. |
| `sellTradeMax` | Largest sell trade | quote | free | Value of the single largest taker-sell trade in the window. |

## Book walls — cumulative depth bands  
_family key: `bookWalls` · 14 metrics · band names are PERCENT_

| metric key | label | unit | min plan | measurement |
|---|---|---|---|---|
| `upDepth30` | Ask depth to +30% | quote | free | Resting sell liquidity from the best ask up to 30% above it. |
| `upDepth60` | Ask depth to +60% | quote | pro | Resting sell liquidity from the best ask up to 60% above it. |
| `upDepth100` | Ask depth to +100% | quote | pro | Resting sell liquidity from the best ask up to 100% above it. |
| `upDepth200` | Ask depth to +200% | quote | pro | Resting sell liquidity from the best ask up to 200% above it. |
| `upDepth300` | Ask depth to +300% | quote | max | Resting sell liquidity from the best ask up to 300% above it. |
| `upDepth400` | Ask depth to +400% | quote | max | Resting sell liquidity from the best ask up to 400% above it. |
| `upDepthFull` | Total ask depth | quote | max | All resting sell liquidity across the entire order book. |
| `downDepth5` | Bid depth to -5% | quote | free | Resting buy liquidity from the best bid down to 5% below it. |
| `downDepth10` | Bid depth to -10% | quote | pro | Resting buy liquidity from the best bid down to 10% below it. |
| `downDepth15` | Bid depth to -15% | quote | pro | Resting buy liquidity from the best bid down to 15% below it. |
| `downDepth20` | Bid depth to -20% | quote | pro | Resting buy liquidity from the best bid down to 20% below it. |
| `downDepthFull` | Total bid depth | quote | max | All resting buy liquidity across the entire order book. |
| `askDepthReachPct` | Ask book reach | percent | pro | How far above the best ask, **in percent**, the book we maintain actually reaches this window. It is the ceiling on every ask-side depth column: a band wider than this reach reports only the part of the book we hold. Deliberately "reach", not "coverage" — it states how far the book extends, it does not assert nothing is missing. Not comparable to the bid figure: the ask span is unbounded, so it is routinely enormous. |
| `bidDepthReachPct` | Bid book reach | percent | pro | How far below the best bid, **in percent**, the book we maintain actually reaches. Hard-bounded at 100% by the price floor and usually at or near it; well under 100 means the bid ladder ran out before the band you asked for. Not comparable to the ask figure. |

> ⚠️ **Known catalog bug — unit.** Both reach columns are PERCENT but the catalog declares
> `unit: 'ratio'`. Read them as percent (0–100+, not 0–1). Do not "fix" a value by multiplying by
> 100.

## Order ladders — fixed 3% slices  
_family key: `orderLadders` · 14 metrics_

| metric key | label | unit | min plan | measurement |
|---|---|---|---|---|
| `buyOrderVol3` | Bid volume 0 to 3% | quote | free | Resting buy liquidity in the slice from 0 to 3% below top of book. |
| `buyOrderVol6` | Bid volume 3 to 6% | quote | free | Resting buy liquidity in the slice from 3 to 6% below top of book. |
| `buyOrderVol9` | Bid volume 6 to 9% | quote | pro | Resting buy liquidity in the slice from 6 to 9% below top of book. |
| `buyOrderVol12` | Bid volume 9 to 12% | quote | pro | Resting buy liquidity in the slice from 9 to 12% below top of book. |
| `buyOrderVol15` | Bid volume 12 to 15% | quote | pro | Resting buy liquidity in the slice from 12 to 15% below top of book. |
| `buyOrderVol18` | Bid volume 15 to 18% | quote | max | Resting buy liquidity in the slice from 15 to 18% below top of book. |
| `buyOrderVol21` | Bid volume 18 to 21% | quote | max | Resting buy liquidity in the slice from 18 to 21% below top of book. |
| `sellOrderVol3` | Ask volume 0 to 3% | quote | free | Resting sell liquidity in the slice from 0 to 3% above top of book. |
| `sellOrderVol6` | Ask volume 3 to 6% | quote | free | Resting sell liquidity in the slice from 3 to 6% above top of book. |
| `sellOrderVol9` | Ask volume 6 to 9% | quote | pro | Resting sell liquidity in the slice from 6 to 9% above top of book. |
| `sellOrderVol12` | Ask volume 9 to 12% | quote | pro | Resting sell liquidity in the slice from 9 to 12% above top of book. |
| `sellOrderVol15` | Ask volume 12 to 15% | quote | pro | Resting sell liquidity in the slice from 12 to 15% above top of book. |
| `sellOrderVol18` | Ask volume 15 to 18% | quote | max | Resting sell liquidity in the slice from 15 to 18% above top of book. |
| `sellOrderVol21` | Ask volume 18 to 21% | quote | max | Resting sell liquidity in the slice from 18 to 21% above top of book. |

## Book microstructure — liquidity add / remove / flicker / lifetime  
_family key: `bookMicro` · 11 metrics_

| metric key | label | unit | min plan | measurement |
|---|---|---|---|---|
| `bestBid` | Best bid | price | free | The highest bid price at the moment the window closed. |
| `bestAsk` | Best ask | price | free | The lowest ask price at the moment the window closed. |
| `bookLevelChangeCount` | Book level change count | count | pro | Price-level changes recorded in the window: one per level whose size actually moved, additions and removals alike, both sides. A level re-broadcast at its existing size is not counted. Counting changes rather than messages makes it largely independent of how a venue batches its pushes, but a level born and removed between two pushes never arrives — read it as a **lower bound** on churn. The damping is partial: a residual of roughly 4.5× remains across venues. (This **replaces** `bookUpdateCount`, which counted applied WebSocket frames — a different measurement, not a rename.) |
| `bidLevelCount` | Bid level count | count | pro | Number of price levels on the bid side at window close. |
| `askLevelCount` | Ask level count | count | pro | Number of price levels on the ask side at window close. |
| `bidLiqAdded` | Bid liquidity added | quote | max | Buy-side resting liquidity placed into the book during the window, in quote units. |
| `bidLiqRemoved` | Bid liquidity removed | quote | max | **Gross** decrease in buy-side resting size across the window, with trades at the same price within 500 ms netted out (measured to remove under **0.3%** of the total). Read it as gross bid-side book decrease, not as cancellations alone: the trade netting is small enough that this is essentially all level-decrease notional. |
| `askLiqAdded` | Ask liquidity added | quote | max | Sell-side resting liquidity placed into the book during the window, in quote units. |
| `askLiqRemoved` | Ask liquidity removed | quote | max | **Gross** decrease in sell-side resting size across the window, with trades at the same price within 500 ms netted out (measured to remove under **0.3%** of the total). Read it as gross ask-side book decrease, not as cancellations alone: the trade netting is small enough that this is essentially all level-decrease notional. |

> **The liquidity family is not comparable across venues.** `maintainedDepth` differs 12.5× between
> venues (okx 400 · bitget 500 · bybit/kraken 1,000 · binance/coinbase/gate/mexc/kucoin 5,000), so these are per-window flows
> accumulated against books of very different size. Normalise per row before comparing venues —
> `liqAdded / bookLevelChangeCount` is the closed-form figure, and dividing by a book-size column on
> the same row (`upDepth30 + downDepth5`) also collapses most of the spread.
| `levelFlickerCount` | Level flicker count | count | max | Count of price levels that appeared, vanished, then reappeared within the window (a placed-removed-placed cycle). |
| `levelLifetimeMedianTime` | Median level lifetime | ms | max | Median lifetime, in ms, of price levels that were both created and removed inside the window. |

## Trade timing & cadence  
_family key: `tradeTiming` · 8 metrics_

| metric key | label | unit | min plan | measurement |
|---|---|---|---|---|
| `tradeSilenceMaxTime` | Longest trade silence | ms | max | The longest gap between trades during the window. |
| `tradeGapModeTime` | Common trade interval | ms | max | The most frequent gap between consecutive trades. |
| `tradeGapModeCount` | Common interval count | count | max | How many trades followed the most common interval. |
| `sameQtyTradeCount` | Same-size trade count | count | max | Trades sharing an exact quantity in groups of three or more. |
| `sameQtyMaxCount` | Largest same-size group | count | max | The biggest group of trades sharing an exact quantity. |
| `atc` | Same-instant trade count | count | max | Trades sharing the same millisecond timestamp in clusters of three or more. |
| `atcMaxCluster` | Largest same-instant cluster | count | max | The biggest cluster of trades sharing one millisecond timestamp. |
| `ltc` | Loser round-trip count | count | max | Same-quantity buy then sell round-trips closed at a loss within 30 minutes. |

## Strong (outsized) trades  
_family key: `strong` · 19 metrics_

| metric key | label | unit | min plan | measurement |
|---|---|---|---|---|
| `stc50` | Strong trade count 1.5x | count | pro | Trades at least 1.5 times the average trade size in the window. |
| `stc100` | Strong trade count 2x | count | pro | Trades at least 2 times the average trade size in the window. |
| `stc200` | Strong trade count 3x | count | max | Trades at least 3 times the average trade size in the window. |
| `sbc50` | Strong buy count 1.5x | count | pro | Taker-buy trades at least 1.5 times the average trade size. |
| `sbc100` | Strong buy count 2x | count | pro | Taker-buy trades at least 2 times the average trade size. |
| `sbc200` | Strong buy count 3x | count | max | Taker-buy trades at least 3 times the average trade size. |
| `sbc500` | Strong buy count 6x | count | max | Taker-buy trades at least 6 times the average trade size. |
| `ssc50` | Strong sell count 1.5x | count | pro | Taker-sell trades at least 1.5 times the average trade size. |
| `ssc100` | Strong sell count 2x | count | pro | Taker-sell trades at least 2 times the average trade size. |
| `ssc200` | Strong sell count 3x | count | max | Taker-sell trades at least 3 times the average trade size. |
| `ssc500` | Strong sell count 6x | count | max | Taker-sell trades at least 6 times the average trade size. |
| `sbcVol50` | Strong buy volume 1.5x | quote | pro | Total value of taker-buy trades at least 1.5 times the average size. |
| `sbcVol100` | Strong buy volume 2x | quote | pro | Total value of taker-buy trades at least 2 times the average size. |
| `sbcVol200` | Strong buy volume 3x | quote | max | Total value of taker-buy trades at least 3 times the average size. |
| `sbcVol500` | Strong buy volume 6x | quote | max | Total value of taker-buy trades at least 6 times the average size. |
| `ssVol50` | Strong sell volume 1.5x | quote | pro | Total value of taker-sell trades at least 1.5 times the average size. |
| `ssVol100` | Strong sell volume 2x | quote | pro | Total value of taker-sell trades at least 2 times the average size. |
| `ssVol200` | Strong sell volume 3x | quote | max | Total value of taker-sell trades at least 3 times the average size. |
| `ssVol500` | Strong sell volume 6x | quote | max | Total value of taker-sell trades at least 6 times the average size. |

## Enrichment (market-cap / attention / developer activity)  
_family key: `enrichment` · 18 metrics_

| metric key | label | unit | min plan | measurement |
|---|---|---|---|---|
| `cgMarketCap` | CoinGecko market cap | usd | free | The coin market capitalisation reported by CoinGecko. |
| `cgRank` | CoinGecko rank | index | free | The coin market-cap rank on CoinGecko. |
| `cgAprox` | CoinGecko match confidence | usd | pro | How closely the pair price matched a CoinGecko candidate. |
| `cmcMarketCap` | CoinMarketCap market cap | usd | pro | The coin market capitalisation reported by CoinMarketCap. |
| `cmcDilutedMc` | CoinMarketCap diluted cap | usd | pro | The fully diluted market cap reported by CoinMarketCap. |
| `cmcSelfMc` | CoinMarketCap self-reported cap | usd | pro | The self-reported market cap from CoinMarketCap. |
| `cmcRank` | CoinMarketCap rank | index | pro | The coin market-cap rank on CoinMarketCap. |
| `cmcLiquidity` | CoinMarketCap liquidity | usd | pro | The effective liquidity for the pair from CoinMarketCap. |
| `cmcVolume` | CoinMarketCap volume | usd | pro | The 24-hour trading volume for the pair from CoinMarketCap. |
| `cgTrendingRank` | CoinGecko trending rank | index | max | The coin's position in CoinGecko's current trending list. |
| `watchlistUsers` | Watchlist users | count | max | How many CoinGecko users hold the coin in a watchlist portfolio. |
| `sentimentUpPct` | Community up-vote share | ratio | max | The share of CoinGecko community up/down votes that are 'up', as a percentage. |
| `githubCommits4w` | GitHub commits (4 weeks) | count | max | Commits to the project's linked GitHub repositories in the last four weeks. |
| `githubStars` | GitHub stars | count | max | Stars on the project's linked GitHub repositories. |
| `githubContributors` | GitHub contributors | count | max | Distinct pull-request contributors to the project's linked GitHub repositories. |
| `newsCount24h` | News articles (24h) | count | max | News articles about the coin in the last 24 hours. |
| `videoCount24h` | Videos (24h) | count | max | Videos about the coin published in the last 24 hours. |
| `aiVisibility` | AI visibility (experimental) | count | max | The size of an AI assistant's generated answer about the coin (experimental). |

## Market context  
_family key: `context` · 9 metrics_

These describe the market, not the pair — the same value is stamped on every row in the window.

| metric key | label | unit | min plan | measurement |
|---|---|---|---|---|
| `btcPriceUsd` | Bitcoin price | price | free | The reference Bitcoin price in USD at the snapshot time. |
| `ethPriceUsd` | Ethereum price | price | free | The reference Ethereum price in USD at the snapshot time. |
| `fearGreed` | Fear and greed index | index | max | The market-wide crypto fear and greed reading. |
| `fearGreedCmc` | Fear and greed index (CMC) | index | max | The CoinMarketCap version of the fear and greed reading. |
| `coinbaseAppRank` | Coinbase app-store rank | index | max | Coinbase's position in the Finance chart of its app store. |
| `coinbaseAppRankRegion` | Coinbase app-rank region | index | max | The app-store storefront region the Coinbase rank was measured in (a code such as `us`). |
| `binanceAppRank` | Binance app-store rank | index | max | Binance's position in the Finance chart of its app store. |
| `binanceAppRankRegion` | Binance app-rank region | index | max | The app-store storefront region the Binance rank was measured in (a code such as `tr`). |
| `cryptoNewsPerHour` | Crypto news arrival rate | count | max | How fast crypto news articles are being published market-wide, in articles per hour. |

> `searchInterest` was **retired in migration 005** — it was never populated. It does not exist; do
> not request it.

## Quality & units (data-integrity fields)  
_family key: `quality` · 11 physical columns, **9 sold**_

| metric key | label | unit | min plan | measurement |
|---|---|---|---|---|
| `qualityFlags` | Row quality flags | count (bitmask) | free | A bitmask of everything known to be wrong with this row; each bit is one named condition, `0` = no known problem. The catalog entry ships the full flag table as `bits`, each with the metric families it `contaminates` — so a broken order book leaves the trade columns on the same row sound. Nothing in the row is hidden, filtered or nulled — this column tells you which values to trust. Name the flag, never a bit number: `PRICE_FROM_LAST_TRADE` marks a window whose price is carried forward from an earlier trade; `QUALITY_UNKNOWN` (mask 32768) means the row predates the quality rail and was never assessed — **unchecked, not unreliable** — and is the ClickHouse column default, so the whole pre-migration-006 archive carries it. |
| `lastTradeAgeTime` | Last trade age | seconds | free | How long before the window closed the pair last traded, in seconds; `0` when the window contained a trade. A large value means the price is real but old. Read it with the `PRICE_FROM_LAST_TRADE` quality flag. |
| `bookObservedAt` | Book observation time | ms | free | The instant the order book was actually read for this row — later than the window close, by a different amount on each venue. This, not `ts`, is when the depth and best bid/ask were true. Use it to line two venues up. |
| `baseAsset` | Base asset | index | free | **Non-queryable — naming it in `columns=` 400s the whole request.** The base asset of the pair — the coin being priced — as the venue itself spells it (kraken, for one, writes bitcoin `XBT` and dogecoin `XDG`). Use it to group or match a coin across venues without splitting the symbol string, which every venue formats differently. Read it with `quoteAsset` to name the full instrument. |
| `quoteAsset` | Quote asset | index | free | **Non-queryable — naming it in `columns=` 400s the whole request.** The currency the pair is quoted in. |
| `quoteUsdRate` | Quote to USD rate | ratio | free | The rate to convert the quote asset into USD. |
| `enrichmentTs` | Enrichment time | ms | free | **Non-queryable — naming it in `columns=` 400s the whole request.** The time the enrichment data was captured. |
| `bookSynced` | Book synced | bool | free | **Non-queryable — do not name it in `columns=`; it 400s the whole request.** When false, read the depth and wall figures on that row as not final. Use `qualityFlags`. |
| `missingTrades` | Missing trades | bool | free | **Non-queryable — naming it in `columns=` 400s the whole request.** Whether some trades may have been missed in the window. Use `qualityFlags`. |

**Not sold — `internal: true`, catalogued but never served:**

| metric key | why |
|---|---|
| `bookAgeTime` | Time since the book was last **re-seeded**, and **larger is healthier** — it is preserved across a warm handover, so a big value means a long uninterrupted run. Any reading of it as a data-staleness or freshness indicator is backwards. It measures our collector, not the market. |
| `seedDepth` | The number of levels the book was seeded with — again a property of our collector. |

Both are accepted-and-ignored if you name them, so a request does not fail, but no value comes
back. Use `qualityFlags` for anything you would have asked them.

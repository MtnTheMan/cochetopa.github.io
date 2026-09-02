---
layout: post
title: "Stand: A Forestry Game About Growing One Tree at a Time"
image: "/assets/images/blog/stand-game.svg"
category: Games
tags: [Stand, forestry, simulation, game development]
author: Parker Hopkins
description: "Introducing Stand, an early browser game about establishing and tending a forest over time."
---

For a while, I have wanted to make a forestry game that actually feels like it is about a forest.

That sounds obvious, but forests are awkward game subjects. They are slow. A good decision can take decades to reveal itself, trees do not politely arrange themselves into progress bars, and the interesting part is usually the interaction among many small processes rather than one dramatic event. Most games solve that by turning the forest into scenery or a pile of resources. I wanted to see what would happen if the stand itself was the game.

The result, at least in its very early form, is [*Stand*](/games/stand/).

## What *Stand* is right now

The current release is v0.0.2, which is an alpha in the most literal sense. It is a working vertical slice, not a finished forest-management game. The playable tree is sugar maple, and the geographic frame is a compact field in Oneida County, Wisconsin.

You begin with a young tree and can establish additional sugar maples, move among close, stand, and wider views, change the speed of time, and watch the little population grow, compete, reproduce, and die. Regeneration points give the player a reason to pay attention to what the stand is doing instead of simply filling every open spot with trees. The game can keep two local save generations in the browser, and saves can also be exported and imported as files.

The other visible trees are ambient scenery for now. They help make the browser world look like a forest, but the game does not pretend that their presence represents a calibrated species-composition model for Oneida County. The geographic context is real; much of the current ecology remains synthetic and deliberately labeled that way. This is important to me because “looks ecological” and “is a defensible ecological model” are not the same thing.

## Why I am building it this way

The longer-term idea is to make forest time and forest decisions legible without making them trivial. I want players to notice establishment, competition, shade, mortality, spatial pattern, disturbance, and the consequences of choosing whether to intervene. Eventually, I would like the game to support more species, more management choices, and more meaningful site differences.

That is a lot to build toward. The current version is one sugar maple and a small patch of Wisconsin, which seems like a reasonable place to start (and also a useful reminder of how much complexity can hide inside “just grow a tree”).

I am preserving the old browser versions as the project develops, so it should remain possible to see what changed between releases rather than having every new build erase the last one.

**[Play *Stand* v0.0.2 →](/games/stand/)**

If you try it, remember that this is an alpha. I am interested in whether the basic loop feels understandable, whether the stand is pleasant to watch, and where the interface gets in the way of seeing what the trees are actually doing.


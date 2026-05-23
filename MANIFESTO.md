## Conceptual

Mixed Messages is a cultural commentary on the internet's divisiveness. Every algorithmic decision is in service of making that legible as art, not data visualization.

The aesthetic is the fragmented, contested, chaotic internet — but instead of appropriating existing culture, the work produces that aesthetic through real-time human inputs. The blockchain doesn't shape the work. It holds it. The human part stays human. Only the output crosses over.

## Rendering Algorithm

### Color

Every submission lands in one of the four quadrants on the two-axis grid. Each quadrant has a color. The algorithm uses those four pure pastel colors with no gradients, neutral tones or mixing. This forces a deliberate choice: place a coordinate and pick a side. The internet does not have a neutral zone. Every prompt triggers something from those seeing and responding to it, and that something falls into one of the four interpretive camps.

The grid is fixed every day, and the axes never change. What changes is the prompt, and the prompt is what makes the colors mean something different each day. The grid is the constant, the prompt is the variable; the people are the noise.

### Cuts

I chose recursive subdivision, where a single white canvas is sliced into smaller and smaller pieces, because it mirrors the actual experience of being online. You start with a single idea, posed neutrally. Then it gets cut up by everyone who responds to it. Each response splits consensus into competing interpretations. What you end up with isn’t a single coherent view of the prompt, but a visible record of how it fractured under contact with different minds.

Each cut is violent. It’s not a brushstroke or a blend, but a unilateral claim: this part of the canvas belongs to my interpretation now. That’s exactly what posting online is: you’re staking a piece of the discourse and saying “mine, this color.” The next person comes along and takes a piece of yours back, in their color. The final rendering is a record of who said what about the prompt, NOT a synthesis of what the prompt means. There is no synthesis, or coherence.

### Density 

Where many submissions cluster, the algorithm cuts that area into smaller and smaller pieces. The grain of the piece in that zone gets finer and the cuts compound.

This is the literal visual translation of attention. Where the conversation pools, the texture intensifies. A high-participation zone reads as visual noise - densely packed slices dissolved into pixelation. A quiet corner of the grid stays as one big undisturbed rectangle. The piece reflects where the here was, not just where the opinions were.

It's also the closest the algorithm gets to honesty about how the internet actually works. The loudest, most contested takes don’t make the conversation more coherent. They just make it louder and more finely-cut. The piece doesn’t reward consensus, but engagement. Just like the platforms we use.

### Dispersion 

Not every cut lands where it should. Most of the time (4 in 5), a submission picks the region closest to where it placed its dot, and the canvas reads as a rough map of who said what, where. But 1 in 5 submissions skips the closest region and picks one at random, area-weighted. The submission's color still gets painted, it just gets painted somewhere you might not expect it to.

This is the algorithm's nod to the fact that takes don't stay in their lane online. An Honest x Uniting opinion is supposed to live near the top right of the canvas. But online discourse doesn't respect quadrants. A take posted into one corner of the discourse ends up rendered next to an unrelated take from a different corner, because that's what algorithmic feeds do. The piece isn't a chart of where opinions clustered. It's a record of where they bled.

### Conviction

A submission near a corner of the grid, farther along the y or x axis from the center, claims a larger slice of its region than a submission near the middle.

Conviction has weight. If you’re sure the prompt is extremely dividing and performed, your submission leaves a bigger mark. Conviction also picks the cut direction. If your stronger opinion is on the Honest/Performed (x) axis, you're sure about how the prompt is being used, but not as sure about what it does. Your cut runs vertically and splits left from right, along the axis you cared about. If your stronger opinion is on the Uniting/Dividing (y) axis, your cut runs horizontally and splits top from bottom. A submission that's strong on both axes splits along whichever axis won a weighted toss. The dimension of your conviction shapes the geometry of your mark. You don't just cut harder; you cut along the line you actually had an opinion about.

The cap on a single submission’s claim is 70%. The piece is meant to be a record of the collective interpretation, not a monument to whoever felt most strongly first. Extreme views still leave a visible mark; they just no longer drown out everyone else’s.

This is the most explicitly editorial decision in the whole algorithm. The internet rewards loudness. This algorithm does too, but proportionally, not absolutely.

### Order

Before any cuts happen, all the submissions get reshuffled into a deterministic order based on the day's prompt. The first person who submitted has no special claim on the canvas. Whoever the shuffle puts first is now first.

This is a fairness move. The participant who submitted in the first minute of the submission window gets the same voice as one who submitted at the end.

The shuffle is seeded by the prompt itself, so the result is reproducible. Same prompt + same submissions = same shuffle = same final piece, every time, forever. The prompt is what determines what order the voices are heard in. The prompt does the work of curating its own response.

### Spacing 

The algorithm starts as a single white square. After all the cuts, some original white survives - places no one's submission happened to land. At the end, every remaining white region, whether on the edge of the canvas or landlocked, gets recolored. No white inside the piece. No white at the edges. The piece is fully painted.

The reasoning is conceptual: the internet does not produce silence. There are no deliberate gaps in the discourse. Every absence is filled by whoever's loud enough to fill it. The piece reflects that. Where the conversation didn't reach, the algorithm fills in on its behalf.

The fill isn't random. Each gap samples from a distribution weighted by participation. The more submissions a quadrant had, the more likely its color is to fill an empty region. The majority opinion of the day spreads into the spaces where the conversation didn't happen.

With a twist: each gap's local matching color is discounted to 30% of its weight. If a region sits in the Dividing x Honest (blue) corner of the canvas, the algorithm preferentially fills it with one of the other three colors. The result: dominant colors end up everywhere except where they originated. The day's loudest voice colonizes the territory of the other quadrants instead of doubling down on its own corner. That's the modern internet rendered in geometry. The loudest takes don't stay in the conversation that produced them; they show up in everyone else's threads, in the empty spaces where other people were having other conversations. The piece feels crowded by the day's majority opinion - crowded everywhere except the corner that produced it.

The piece is always whole. It's always a complete square. It always has a hard edge against the white of the website behind it.

### Salt 

After the cuts and the fill, the algorithm scatters K tiny boxes at random positions across the canvas, each colored from the same participation-weighted, locally-discounted distribution as the fill. Each salt box is small and lands near an edge of the region it sits in. K depends on participation: K ≈ 120 / (20 + √N). High when N is low. Low when N is high.

Every conversation has chaff. Outlier takes, half-formed thoughts, the post you scrolled past without registering it. In a high-volume conversation, the chaff gets buried under the weight of the dominant positions - it's there, but the structure of the discourse drowns it out. In a low-volume conversation, the chaff is the visible texture. Salt is the algorithm's acknowledgment that the artifact of online discourse isn't just the loudest positions. It's the noise around them, and how much of that noise you see depends on how loud the rest of the room is.

Functionally, salt keeps low-participation days from looking too clean. Five submissions on a quiet day would otherwise produce five big rectangles. Salt scatters that into something that reads as a piece, not a flag. Salt thins out on high-participation days because the base layer has already produced its own chaff.

Salt also spreads majority colors across the canvas the same way the fill does. Where the fill paints big regions in the day's loudest tones, salt sprinkles those same tones in fine accents over the whole field. The dominant voice doesn't just colonize the silence. It also speckles the conversation. That's how virality works.

### Gridlines and Axis Markers

There are none. No axis labels, tick marks, quadrant divider lines, or caption underneath. Anyone looking at the piece without context can't tell which corner was which interpretation. This is on purpose. The piece is not a chart. It's not data visualization. It's a record of disagreement that should function as art, visible to people who don't know the rules of Mixed Messages, beautiful or ugly or strange or boring without needing a key to read it.

The meaning lives in the metadata, in the archive, in the prompt that day, and in the participant count. The visible artifact is the shape of the disagreement, stripped of explanatory scaffolding.

### Animation

There is none. Final pieces are single SVGs, frozen at the moment the submission window closed. The piece is a document of what happened on a particular day, when a particular prompt was posed to a particular crowd.

The networked, generative, real-time stuff happens before the freeze. The live field updates as submissions roll in, the auction runs as a clock, the participation count climbs. But the output - the 1/1 - is fixed in time.

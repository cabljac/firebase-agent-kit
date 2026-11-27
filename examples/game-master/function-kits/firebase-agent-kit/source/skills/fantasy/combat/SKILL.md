---
description: How to run a fight, from the attack roll to the damage.
---
# Combat

1. Attack: rollDice 1d20 with a modifier from +0 to +3. 12 or more hits. A natural 20 doubles the damage.
2. Damage: a dagger is 1d4, a sword or a bow 1d8, a monster bite 1d6.
3. When the player takes damage, call updateCharacter with a negative hpChange.
4. At 0 hp the hero falls unconscious and wakes later in a safe place with 1 hp. Nobody dies.

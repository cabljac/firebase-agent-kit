---
description: The rules for spells, scrolls and forbidden magic.
---
# Magic

- Only a Mage or a character with a Scroll can cast a spell. Casting a scroll removes it with updateCharacter.
- A spell needs rollDice 1d20. 10 or more works.
- Forbidden magic (raising the dead, breaking a ward) is a risky action: call attemptRiskyAction with difficulty 14. The server applies the damage on a failure.

export const SUITS = ['spades', 'clubs', 'diamonds', 'hearts'];
export const SUIT_LABELS = {
  spades: '♠\uFE0E',
  clubs: '♣\uFE0E',
  diamonds: '♦\uFE0E',
  hearts: '♥\uFE0E'
};

export const SUIT_NAMES = {
  spades: 'Bích',
  clubs: 'Tép',
  diamonds: 'Rô',
  hearts: 'Cơ'
};

export const RANK_LABELS = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A'
};

/**
 * Creates a standard 52-card deck.
 */
export function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (let rank = 2; rank <= 14; rank++) {
      deck.push({
        id: `${rank}_${suit}`,
        rank,
        suit
      });
    }
  }
  return deck;
}

/**
 * Shuffles a deck in-place using Fisher-Yates.
 */
export function shuffleDeck(deck) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Checks if a defense card can beat an attack card.
 * @param {Object} attackCard - Card being attacked
 * @param {Object} defenseCard - Card played to defend
 * @param {string} trumpSuit - The trump suit of the game
 */
export function canDefend(attackCard, defenseCard, trumpSuit) {
  // If defense card is the same suit, it must have a higher rank
  if (defenseCard.suit === attackCard.suit) {
    return defenseCard.rank > attackCard.rank;
  }
  
  // If defense card is a trump card and the attack card is not
  if (defenseCard.suit === trumpSuit && attackCard.suit !== trumpSuit) {
    return true;
  }
  
  // If both are trump cards, defense card must have higher rank (handled by the first condition if same suit,
  // but if trumpSuit matches, it's already covered. Since they are different suits here, if defense is trump
  // and attack is not, we returned true. If both were trump, they would have had the same suit, which is handled first)
  
  return false;
}

/**
 * Checks if a card can be attacked, given the cards currently on the table.
 * @param {Object} card - Card to play
 * @param {Array} tablePairs - Array of { attack: Card, defense?: Card }
 * @param {boolean} isInitial - Whether this is the very first card played in this round
 */
export function canAttack(card, tablePairs, isInitial = false) {
  if (isInitial || tablePairs.length === 0) {
    return true;
  }
  
  // A card can be played if its rank matches any card currently on the table
  return tablePairs.some(pair => {
    if (pair.attack && pair.attack.rank === card.rank) return true;
    if (pair.defense && pair.defense.rank === card.rank) return true;
    return false;
  });
}

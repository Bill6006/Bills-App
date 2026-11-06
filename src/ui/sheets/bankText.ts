/** Plain-language reason a bank transaction was left out of your spending. */
export const skipReason = (how: string): string => {
  if (how.startsWith('bill:')) return `Your ${how.slice(5)} bill`;
  return ({ transfer: 'Transfer', paycheck: 'Paycheck', 'card payment': 'Card payment', 'money in': 'Money in', rule: 'You skip this store', you: 'You said not spending' } as Record<string, string>)[how] || 'Not spending';
};

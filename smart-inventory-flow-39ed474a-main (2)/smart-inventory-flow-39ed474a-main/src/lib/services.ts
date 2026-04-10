import DB, { type Product, type Alert, type Suggestion, type Sale, type ActionLog } from './database';
import { getDaysUntilExpiry, normalizeExpiryDate } from './inventory-utils';

function sanitizeProductInput(p: Partial<Product>): Partial<Product> {
  if (!('expiryDate' in p)) return p;
  return { ...p, expiryDate: normalizeExpiryDate(p.expiryDate) };
}

// Auth
export const Auth = {
  signup: (data: { fullName: string; username: string; email: string; password: string; role?: string }) => {
    if (!data.fullName || !data.username || !data.email || !data.password)
      return { error: 'All fields are required.' };
    if (DB.findOne('users', (u: any) => u.username === data.username))
      return { error: 'Username already exists.' };
    if (DB.findOne('users', (u: any) => u.email === data.email))
      return { error: 'Email already registered.' };
    if (data.password.length < 6)
      return { error: 'Password must be at least 6 characters.' };
    const user = DB.insert('users', data);
    return { user };
  },
  login: (data: { username: string; password: string }) => {
    if (!data.username || !data.password)
      return { error: 'Username and password are required.' };
    const user = DB.findOne('users', (u: any) => u.username === data.username && u.password === data.password);
    if (!user) return { error: 'Invalid username or password.' };
    return { user };
  }
};

// Inventory
export const Inv = {
  add: (bizId: string, p: Partial<Product>) => {
    if (p.barcode && DB.findOne<Product>('products', x => x.barcode === p.barcode && x.businessId === bizId))
      return { error: 'Barcode already exists for this business.' };
    const sanitized = sanitizeProductInput({ ...p, businessId: bizId, salesCount: 0, lastSold: null });
    const prod = DB.insert('products', sanitized);
    return { product: prod };
  },
  get: (bizId: string): Product[] => DB.findMany<Product>('products', p => p.businessId === bizId),
  recordSale: (bizId: string, pId: string, qty: number, price: number) => {
    const p = DB.findOne<Product>('products', x => x.id === pId);
    if (!p) return { error: 'Product not found.' };
    if (p.quantity < qty) return { error: `Insufficient stock. Only ${p.quantity} units available.` };
    DB.update<Product>('products', pId, {
      quantity: p.quantity - qty,
      salesCount: (p.salesCount || 0) + qty,
      lastSold: new Date().toISOString()
    } as Partial<Product>);
    const sale = DB.insert('sales', {
      businessId: bizId, productId: pId, productName: p.name,
      qty, salePrice: price, costPrice: p.costPrice,
      profit: (price - p.costPrice) * qty
    });
    return { sale };
  },
  bulk: (bizId: string, items: Partial<Product>[]) => {
    let added = 0;
    const errors: string[] = [];
    items.forEach((p, i) => {
      // Skip duplicate barcodes silently if barcode exists
      if (p.barcode && DB.findOne<Product>('products', x => x.barcode === p.barcode && x.businessId === bizId)) {
        errors.push(`Row ${i + 1}: Barcode "${p.barcode}" already exists (skipped)`);
        return;
      }
      const sanitized = sanitizeProductInput({ ...p, businessId: bizId, salesCount: 0, lastSold: null });
      DB.insert('products', sanitized);
      added++;
    });
    return { added, errors };
  },
  updateProduct: (id: string, updates: Partial<Product>) => {
    return DB.update<Product>('products', id, sanitizeProductInput(updates));
  },
  deleteProduct: (id: string) => {
    DB.del<Product>('products', id);
  },
  removeExpired: (bizId: string, productId: string) => {
    DB.del<Product>('products', productId);
  }
};

// Action History
export const ActionHistory = {
  log: (bizId: string, productId: string, productName: string, actionType: ActionLog['actionType'], description: string, details?: string) => {
    DB.insert('action_logs', { businessId: bizId, productId, productName, actionType, description, details: details || '' });
  },
  get: (bizId: string): ActionLog[] => {
    return DB.findMany<ActionLog>('action_logs', a => a.businessId === bizId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
};

// Helper: sales speed
export function getSalesSpeed(p: Product): number {
  if (!p.salesCount || p.salesCount === 0) return 0;
  const daysSinceCreated = Math.max(1, Math.ceil((Date.now() - new Date(p.createdAt).getTime()) / 86400000));
  return p.salesCount / daysSinceCreated;
}

export function getDaysUntilStockout(p: Product): number {
  const speed = getSalesSpeed(p);
  if (speed === 0) return Infinity;
  return Math.ceil(p.quantity / speed);
}

// Calculate a sensible reorder quantity based on sales speed and reorder point
function sensibleReorderQty(p: Product): number {
  const speed = getSalesSpeed(p);
  if (speed > 0) {
    // Order enough for ~30 days of sales, capped at reasonable limits
    const qty = Math.ceil(speed * 30);
    return Math.max(p.reorderPoint || 10, Math.min(qty, Math.max(200, (p.reorderPoint || 10) * 5)));
  }
  // No sales data: use reorder point * 2 or a reasonable default
  const rp = p.reorderPoint || 10;
  return Math.min(rp * 3, 200);
}

// Alerts - categorized
export const AlertSvc = {
  generate: (products: Product[]): Alert[] => {
    const alerts: Alert[] = [];
    const today = new Date();
    products.forEach(p => {
      // === EXPIRED ===
      const d = getDaysUntilExpiry(p.expiryDate, today);
      if (d !== null) {
        if (d <= 0) {
          const lossAmount = p.costPrice * p.quantity;
          const catLow = p.category.toLowerCase();
          let reason = '';
          if (['food', 'dairy', 'bakery', 'snacks', 'beverages', 'grocery'].some(k => catLow.includes(k))) {
            reason = `Expired food is a health hazard — risk of food poisoning. You lose ${formatCurrency(lossAmount)} if not removed.`;
          } else if (['medicine', 'pharma', 'health', 'supplement'].some(k => catLow.includes(k))) {
            reason = `Expired medicine is dangerous and illegal to sell. Potential loss: ${formatCurrency(lossAmount)}.`;
          } else if (['cosmetic', 'beauty', 'skincare', 'personal care'].some(k => catLow.includes(k))) {
            reason = `Expired cosmetics can cause skin reactions and allergies. Value at risk: ${formatCurrency(lossAmount)}.`;
          } else if (['electronics', 'battery', 'gadget'].some(k => catLow.includes(k))) {
            reason = `Expired electronics (batteries, etc.) can leak or malfunction. Loss: ${formatCurrency(lossAmount)}.`;
          } else {
            reason = `Expired stock blocks shelf space and risks customer trust. Total loss: ${formatCurrency(lossAmount)}.`;
          }
          alerts.push({
            type: 'EXPIRED', severity: 'danger', productId: p.id, productName: p.name,
            category: 'expired',
            message: `${p.name} expired ${Math.abs(d)} day(s) ago. ${p.quantity} units still on shelf.`,
            reason,
            action: 'Remove from shelf immediately — dispose safely or return to supplier if possible',
            potentialLoss: lossAmount > 0 ? lossAmount : undefined,
            actionType: 'remove'
          });
        }
        // === EXPIRING SOON ===
        else if (d <= 30) {
          const speed = getSalesSpeed(p);
          const canSellInTime = speed > 0 ? Math.floor(speed * d) : 0;
          const unitsAtRisk = Math.max(0, p.quantity - canSellInTime);
          const lossAmount = p.costPrice * unitsAtRisk;
          const discount = d <= 3 ? 40 : d <= 7 ? 30 : d <= 14 ? 20 : 15;
          const discountedPrice = p.sellingPrice * (1 - discount / 100);
          const minProfit = (discountedPrice - p.costPrice) * p.quantity;

          let priorityColor: 'red' | 'orange' | 'yellow' = 'yellow';
          if (d <= 3) priorityColor = 'red';
          else if (d <= 7) priorityColor = 'orange';

          alerts.push({
            type: 'EXPIRING_SOON', severity: d <= 7 ? 'danger' : 'warning', productId: p.id, productName: p.name,
            category: 'expiring',
            message: `${p.name} expires in ${d} day(s). ${p.quantity} units remaining.`,
            reason: speed > 0
              ? `At current sales speed (${speed.toFixed(1)} units/day), you can sell ~${canSellInTime} units before expiry. ${unitsAtRisk > 0 ? `${unitsAtRisk} units will likely go unsold.` : 'All units may sell in time if promoted.'}`
              : `No recent sales recorded. All ${p.quantity} units are at risk of expiring unsold.`,
            action: `Apply ${discount}% discount (sell at ${formatCurrency(discountedPrice)}). ${minProfit >= 0 ? `You still profit ${formatCurrency(minProfit)} total.` : `You lose ${formatCurrency(Math.abs(minProfit))}, but that's better than losing ${formatCurrency(lossAmount)} if unsold.`}`,
            potentialLoss: lossAmount > 0 ? lossAmount : undefined,
            actionType: 'discount',
            priorityColor,
            daysLeft: d,
            discountPercent: discount
          });
        }
      }

      // === OUT OF STOCK ===
      if (p.quantity === 0) {
        const speed = getSalesSpeed(p);
        alerts.push({
          type: 'OUT_OF_STOCK', severity: 'danger', productId: p.id, productName: p.name,
          category: 'outofstock',
          message: `${p.name} is completely out of stock.`,
          reason: speed > 0
            ? `This item was selling at ${speed.toFixed(1)} units/day. Every day without stock, you lose ~${formatCurrency(speed * (p.sellingPrice - p.costPrice))} in potential profit.`
            : 'Customers looking for this item will be turned away, potentially losing future business.',
          action: `Reorder ${sensibleReorderQty(p)} units immediately`,
          actionType: 'reorder'
        });
      }
      // LOW STOCK
      else if (p.quantity <= p.reorderPoint) {
        const speed = getSalesSpeed(p);
        const daysLeft = speed > 0 ? Math.ceil(p.quantity / speed) : 999;
        alerts.push({
          type: 'LOW_STOCK', severity: 'warning', productId: p.id, productName: p.name,
          category: 'lowstock',
          message: `${p.name}: only ${p.quantity} units left (reorder point: ${p.reorderPoint}).`,
          reason: speed > 0
            ? `At current rate (${speed.toFixed(1)} units/day), stock runs out in ~${daysLeft} days. You'll miss sales if not restocked.`
            : 'Stock is below your set reorder point. Restock to avoid running out.',
          action: `Reorder ${sensibleReorderQty(p)} units now`,
          actionType: 'reorder',
          daysLeft
        });
      }

      // === OVERSTOCK ===
      if (p.quantity > (p.reorderPoint || 10) * 5 && p.salesCount < p.quantity * 0.1) {
        const speed = getSalesSpeed(p);
        const capitalBlocked = p.costPrice * p.quantity;
        const daysToSell = speed > 0 ? Math.ceil(p.quantity / speed) : Infinity;
        alerts.push({
          type: 'OVERSTOCK', severity: 'info', productId: p.id, productName: p.name,
          category: 'overstock',
          message: `${p.name}: ${p.quantity} units in stock (${Math.round(p.quantity / (p.reorderPoint || 10))}x your reorder point).`,
          reason: speed > 0
            ? `At current sales speed (${speed.toFixed(1)} units/day), it will take ~${daysToSell} days to sell all. ${formatCurrency(capitalBlocked)} is blocked in this item.`
            : `No sales recorded. ${formatCurrency(capitalBlocked)} capital is stuck. ${p.expiryDate ? 'Risk of expiry before selling.' : ''}`,
          action: `Don't reorder. Try 10-15% discount, bundle deals (Buy 1 Get 1), or promote via ads to clear stock faster.`,
          actionType: 'discount',
          potentialLoss: capitalBlocked
        });
      }

      // === DEAD STOCK (separate category) ===
      if (p.lastSold) {
        const daysSinceLastSale = Math.ceil((today.getTime() - new Date(p.lastSold).getTime()) / 86400000);
        if (daysSinceLastSale > 60 && p.quantity > 0) {
          alerts.push({
            type: 'DEAD_STOCK', severity: 'danger', productId: p.id, productName: p.name,
            category: 'deadstock',
            message: `${p.name}: No sale in ${daysSinceLastSale} days. ${p.quantity} units sitting idle.`,
            reason: `Capital worth ${formatCurrency(p.costPrice * p.quantity)} is blocked. The longer this stock sits, the higher the risk of damage, obsolescence${p.expiryDate ? ', or expiry' : ''}. Do NOT reorder this item — focus on selling existing stock first.`,
            action: `Avoid reordering. Apply 20-30% discount, create Buy 1 Get 1 bundle deals, or run promotional ads to attract buyers. ${formatCurrency(p.costPrice * p.quantity)} is stuck — every day unsold increases the loss.`,
            actionType: 'discount',
            potentialLoss: p.costPrice * p.quantity
          });
        }
      }

      // === SALES SPEED TRACKING (slow movers) ===
      if (p.lastSold) {
        const daysSinceLastSale = Math.ceil((today.getTime() - new Date(p.lastSold).getTime()) / 86400000);
        if (daysSinceLastSale > 30 && daysSinceLastSale <= 60 && p.quantity > 0) {
          alerts.push({
            type: 'SLOW_MOVING', severity: 'warning', productId: p.id, productName: p.name,
            category: 'salesspeed',
            message: `${p.name}: No sale in ${daysSinceLastSale} days. Becoming slow-moving stock.`,
            reason: `Demand appears low. Without promotion, this may become dead stock. ${formatCurrency(p.costPrice * p.quantity)} capital is at risk of getting stuck.`,
            action: 'Run promotional ads to attract buyers. Consider a 10-15% discount, place at a prominent shelf position, or bundle with fast-selling items.',
            actionType: 'discount',
            potentialLoss: p.costPrice * p.quantity
          });
        }
      }

      // === SEASONAL (summer detection) ===
      const month = today.getMonth(); // 0-indexed
      const isSummer = month >= 2 && month <= 5; // March-June
      const isWinter = month >= 10 || month <= 1; // Nov-Feb
      const summerKeywords = ['cooler', 'fan', 'ac', 'air conditioner', 'ice', 'cold', 'juice', 'water', 'sunscreen', 'umbrella', 'lemon', 'mango', 'curd', 'lassi', 'buttermilk'];
      const winterKeywords = ['heater', 'blanket', 'sweater', 'jacket', 'warm', 'hot chocolate', 'soup', 'tea', 'coffee'];
      const nameLower = p.name.toLowerCase();
      const catLower = p.category.toLowerCase();

      if (isSummer && summerKeywords.some(k => nameLower.includes(k) || catLower.includes(k))) {
        const speed = getSalesSpeed(p);
        if (p.quantity <= p.reorderPoint * 2) {
          alerts.push({
            type: 'SEASONAL_DEMAND', severity: 'warning', productId: p.id, productName: p.name,
            category: 'seasonal',
            message: `Summer demand: ${p.name} is a seasonal hot-seller. Only ${p.quantity} units left.`,
            reason: 'Summer increases demand for cooling/refreshment products. Low stock during peak season means lost revenue.',
            action: `Stock up! Reorder at least ${(sensibleReorderQty(p)) * 2} units to meet summer demand.`,
            actionType: 'reorder'
          });
        }
      }
      if (isWinter && winterKeywords.some(k => nameLower.includes(k) || catLower.includes(k))) {
        if (p.quantity <= p.reorderPoint * 2) {
          alerts.push({
            type: 'SEASONAL_DEMAND', severity: 'warning', productId: p.id, productName: p.name,
            category: 'seasonal',
            message: `Winter demand: ${p.name} is a seasonal hot-seller. Only ${p.quantity} units left.`,
            reason: 'Winter increases demand for warming products. Low stock during peak season means lost revenue.',
            action: `Stock up! Reorder at least ${(sensibleReorderQty(p)) * 2} units to meet winter demand.`,
            actionType: 'reorder'
          });
        }
      }
    });
    // Sort by priority: danger first, then warning, then info; within same severity, by daysLeft ascending
    const sevOrder: Record<string, number> = { danger: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => {
      const sa = sevOrder[a.severity] ?? 3;
      const sb = sevOrder[b.severity] ?? 3;
      if (sa !== sb) return sa - sb;
      const da = a.daysLeft ?? 999;
      const db = b.daysLeft ?? 999;
      return da - db;
    });
    return alerts;
  },

  // Suggestions - distinct from alerts, overall actionable advice
  suggestions: (products: Product[]): Suggestion[] => {
    const s: Suggestion[] = [];
    const today = new Date();

    // Overall inventory health suggestions
    const totalValue = products.reduce((sum, p) => sum + p.costPrice * p.quantity, 0);
    const outOfStock = products.filter(p => p.quantity === 0);
    const overstocked = products.filter(p => p.quantity > (p.reorderPoint || 10) * 5);
    const expiringItems = products.filter(p => {
      const d = getDaysUntilExpiry(p.expiryDate, today);
      if (d === null) return false;
      return d > 0 && d <= 30;
    });
    const slowMovers = products.filter(p => p.lastSold && Math.ceil((today.getTime() - new Date(p.lastSold).getTime()) / 86400000) > 30 && p.quantity > 0);
    const fastMovers = products.filter(p => getSalesSpeed(p) > 0).sort((a, b) => getSalesSpeed(b) - getSalesSpeed(a));

    // Fast movers running low - reorder suggestion
    fastMovers.forEach(p => {
      const speed = getSalesSpeed(p);
      const daysLeft = getDaysUntilStockout(p);
      if (daysLeft < 14 && p.quantity > 0) {
        s.push({
          type: 'REORDER_FAST_SELLER',
          productId: p.id, productName: p.name,
          suggestion: `${p.name} sells at ${speed.toFixed(1)} units/day and will run out in ~${daysLeft} days. Reorder ${Math.max(sensibleReorderQty(p), Math.ceil(speed * 30))} units to cover next 30 days.`,
          priority: daysLeft < 7 ? 'high' : 'medium'
        });
      }
    });

    // Expiring items - discount + bundle strategy
    expiringItems.forEach(p => {
      const d = getDaysUntilExpiry(p.expiryDate, today);
      if (d === null) return;
      const discount = d <= 3 ? 40 : d <= 7 ? 30 : d <= 14 ? 20 : 15;
      const discountedPrice = p.sellingPrice * (1 - discount / 100);
      const profitPerUnit = discountedPrice - p.costPrice;
      s.push({
        type: 'CLEAR_EXPIRING',
        productId: p.id, productName: p.name,
        suggestion: `${p.name} expires in ${d} days. Apply ${discount}% discount (${formatCurrency(discountedPrice)}/unit). ${profitPerUnit >= 0 ? `You still earn ${formatCurrency(profitPerUnit)}/unit profit.` : `Small loss of ${formatCurrency(Math.abs(profitPerUnit))}/unit, but better than losing ${formatCurrency(p.costPrice)}/unit entirely.`} Consider Buy 1 Get 1 deals to move faster.`,
        priority: d <= 7 ? 'high' : 'medium'
      });
    });

    // Slow movers - promotion strategy
    slowMovers.forEach(p => {
      const daysSince = Math.ceil((today.getTime() - new Date(p.lastSold!).getTime()) / 86400000);
      s.push({
        type: 'PROMOTE_SLOW_ITEM',
        productId: p.id, productName: p.name,
        suggestion: `${p.name} hasn't sold in ${daysSince} days. Run promotional ads, place at eye-level shelves, or offer 10-15% discount. ${formatCurrency(p.costPrice * p.quantity)} capital is blocked.`,
        priority: daysSince > 60 ? 'high' : 'medium'
      });
    });

    // Overstock - don't reorder + clear strategy
    overstocked.forEach(p => {
      s.push({
        type: 'CLEAR_OVERSTOCK',
        productId: p.id, productName: p.name,
        suggestion: `${p.name} is overstocked (${p.quantity} units, ${Math.round(p.quantity / (p.reorderPoint || 10))}x reorder point). Do NOT reorder. Offer bundle deals, 10% discount, or advertise to clear. ${formatCurrency(p.costPrice * p.quantity)} tied up.`,
        priority: 'medium'
      });
    });

    // Out of stock - urgent reorder
    outOfStock.forEach(p => {
      const speed = getSalesSpeed(p);
      s.push({
        type: 'URGENT_RESTOCK',
        productId: p.id, productName: p.name,
        suggestion: `${p.name} is OUT OF STOCK! ${speed > 0 ? `Was selling ${speed.toFixed(1)} units/day. ` : ''}Reorder ${sensibleReorderQty(p)} units now to avoid losing customers.`,
        priority: 'high'
      });
    });

    // Overall summary suggestions
    const expiredItems = products.filter(p => {
      const d = getDaysUntilExpiry(p.expiryDate, today);
      return d !== null && d <= 0;
    });
    if (expiredItems.length > 0) {
      s.unshift({
        type: 'OVERALL_EXPIRED',
        productId: '', productName: 'Overall',
        suggestion: `⚠️ You have ${expiredItems.length} expired item(s). Remove them immediately to prevent contamination and health risks. Go to Alerts → Expired to take action.`,
        priority: 'high'
      });
    }
    if (overstocked.length > 0) {
      s.unshift({
        type: 'OVERALL_OVERSTOCK',
        productId: '', productName: 'Overall',
        suggestion: `📦 ${overstocked.length} item(s) are overstocked. Apply discounts (10-15%), create bundle offers, and promote via ads to clear stock and free up capital.`,
        priority: 'medium'
      });
    }
    if (slowMovers.length > 0) {
      s.unshift({
        type: 'OVERALL_SLOW',
        productId: '', productName: 'Overall',
        suggestion: `🐌 ${slowMovers.length} item(s) are not moving. Consider promotions, shelf repositioning, or discounts. If stock is not selling, do NOT reorder — focus on clearing existing inventory.`,
        priority: 'medium'
      });
    }
    const lowStockFast = products.filter(p => p.quantity > 0 && p.quantity <= p.reorderPoint);
    if (lowStockFast.length > 0) {
      s.unshift({
        type: 'OVERALL_LOWSTOCK',
        productId: '', productName: 'Overall',
        suggestion: `📉 ${lowStockFast.length} item(s) are running low. Place reorders soon to avoid stockouts and lost sales.`,
        priority: 'high'
      });
    }

    return s;
  }
};

// Analytics
export const Analytics = {
  financials: (bizId: string) => {
    const sales = DB.findMany<Sale>('sales', s => s.businessId === bizId);
    const prods = DB.findMany<Product>('products', p => p.businessId === bizId);
    return {
      totalRevenue: sales.reduce((s, x) => s + x.salePrice * x.qty, 0),
      totalCost: sales.reduce((s, x) => s + x.costPrice * x.qty, 0),
      totalProfit: sales.reduce((s, x) => s + x.profit, 0),
      inventoryValue: prods.reduce((s, p) => s + p.costPrice * p.quantity, 0),
      potentialLoss: prods.reduce((s, p) => {
        const d = getDaysUntilExpiry(p.expiryDate);
        if (d !== null && d <= 30)
          return s + p.costPrice * p.quantity;
        return s;
      }, 0),
      salesCount: sales.length,
      avgOrderValue: sales.length > 0 ? sales.reduce((s, x) => s + x.salePrice * x.qty, 0) / sales.length : 0
    };
  },
  weekly: (bizId: string) => {
    const sales = DB.findMany<Sale>('sales', s => s.businessId === bizId);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const data = days.map(d => ({ day: d, revenue: 0, profit: 0 }));
    sales.forEach(s => {
      const d = new Date(s.createdAt).getDay();
      data[d].revenue += s.salePrice * s.qty;
      data[d].profit += s.profit;
    });
    return data;
  },
  categories: (bizId: string) => {
    const prods = DB.findMany<Product>('products', p => p.businessId === bizId);
    const c: Record<string, { count: number; value: number }> = {};
    prods.forEach(p => {
      if (!c[p.category]) c[p.category] = { count: 0, value: 0 };
      c[p.category].count++;
      c[p.category].value += p.costPrice * p.quantity;
    });
    return Object.entries(c).map(([name, d]) => ({ name, ...d }));
  }
};

// Alert Sound - plays uploaded WAV file
let alertAudio: HTMLAudioElement | null = null;

export function playAlertSound() {
  try {
    // Stop any currently playing alert
    if (alertAudio) {
      alertAudio.pause();
      alertAudio.currentTime = 0;
    }
    alertAudio = new Audio('/alert-sound.wav');
    alertAudio.volume = 1.0;
    alertAudio.play().catch(() => {});
  } catch { /* silent */ }
}

export function stopAlertSound() {
  if (alertAudio) {
    alertAudio.pause();
    alertAudio.currentTime = 0;
    alertAudio = null;
  }
}

// Currency formatter
export function getCurrencySymbol(currency?: string): string {
  if (!currency) return '₹';
  if (currency.includes('$')) return '$';
  if (currency.includes('€')) return '€';
  if (currency.includes('£')) return '£';
  return '₹';
}

export function formatCurrency(amount: number, currency?: string): string {
  const sym = getCurrencySymbol(currency);
  return sym + (amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

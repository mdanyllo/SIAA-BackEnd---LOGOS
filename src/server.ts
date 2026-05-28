// src/server.ts
import 'dotenv/config'; 
import express, { Request as ExpressRequest, Response, NextFunction } from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import helmet from 'helmet';

const prisma = new PrismaClient();
const app = express();

// ── Rate limiting ────────────────────────────────────────────────────────────
// Pedidos: máx 10 por IP a cada 5 minutos (evita spam)
const orderLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos.' },
});

// Login: máx 10 tentativas por IP a cada 15 minutos (evita brute force)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
});

const allowedOrigins = [
  'https://www.atendimentoautomatizado.com.br',
  'https://atendimentoautomatizado.com.br',
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    // Sem origin = Postman, mobile, server-to-server → deixa passar
    if (!origin) return callback(null, true);
    // Localhost em qualquer porta → só deixa passar em desenvolvimento
    if (process.env.NODE_ENV !== 'production' && origin.startsWith('http://localhost')) {
      return callback(null, true);
    }
    // Qualquer subdomínio de atendimentoautomatizado.com.br
    if (origin.endsWith('.atendimentoautomatizado.com.br')) {
      return callback(null, true);
    }
    // Origens explícitas
    if (allowedOrigins.includes(origin)) return callback(null, true);

    return callback(new Error('Origem não permitida pelo CORS'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,                  
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em instantes.' },
});
app.use(globalLimiter);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'SIAA-LOGOSTEC',
    allowed_formats: ['jpg', 'png', 'jpeg', 'pdf'],
  } as any,
});

const upload = multer({ storage: storage });

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('[SIAA] JWT_SECRET não definido no .env. Servidor abortado.'); 
const evolutionBaseUrl = process.env.EVOLUTION_URL?.replace(/\/$/, '');

interface AuthRequest extends ExpressRequest {
  restaurantId?: string;
  storeId?: string;
  serviceId?: string; // <- Aqui resolvemos o erro do serviceId não existir!
  segment?: string;
}

const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction) => {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Acesso negado.' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET) as {
      adminId: string;
      establishmentId: string;
      segment: string;
    };
    
    req.segment = payload.segment;
    
    // Distribuindo o ID para a propriedade correta baseada no segmento:
    if (payload.segment === 'restaurant') req.restaurantId = payload.establishmentId;
    if (payload.segment === 'retail') req.storeId = payload.establishmentId;
    if (payload.segment === 'service') req.serviceId = payload.establishmentId;
    
    next();
  } catch {
    return res.status(403).json({ error: 'Token inválido ou expirado.' });
  }
};
// ============================================================================
// 📱 FUNÇÃO GLOBAL: ENVIO DE WHATSAPP (CLIENTE E DONO)
// ============================================================================
const sendWhatsAppMessage = async (
  restaurant: any,
  targetNumber: string,
  messageText: string,
  mediaUrl?: string
) => {
  if (!targetNumber) return;

  let numeroLimpo = targetNumber.replace(/\D/g, '');
  if (numeroLimpo.startsWith('55')) numeroLimpo = numeroLimpo.substring(2);
  if (numeroLimpo.length === 10) numeroLimpo = `${numeroLimpo.substring(0, 2)}9${numeroLimpo.substring(2)}`;
  const numeroFinal = `55${numeroLimpo}`;

  let endpoint = `/message/sendText/${restaurant.evolutionInstance}`;
  let payload: any = { number: numeroFinal, text: messageText };

  if (mediaUrl) {
    endpoint = `/message/sendMedia/${restaurant.evolutionInstance}`;
    const isPdf = mediaUrl.toLowerCase().endsWith('.pdf');
    payload = {
      number: numeroFinal,
      mediatype: isPdf ? 'document' : 'image',
      media: mediaUrl,
      caption: messageText,
      fileName: isPdf ? 'comprovante.pdf' : 'comprovante.jpg'
    };
  }

  try {
    const response = await fetch(`${evolutionBaseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'apikey': restaurant.evolutionApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    console.log(`[SIAA] ✅ Sucesso WhatsApp (${numeroFinal})`);
    return data;
  } catch (error) {
    console.error(`[SIAA] ❌ Erro WhatsApp (${numeroFinal}):`, error);
  }
};

// ============================================================================
// 🔄 ROTINA: ABERTURA, TURNOS E FECHAMENTO DE CAIXA (RODA A CADA 1 MINUTO)
// ============================================================================
app.post('/cron/fechamento', async (req, res) => {
  // 🔐 proteção via variável de ambiente
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(403).json({ error: "forbidden" });
  }

  try {
    const now = new Date();

    const spTimeOpts: Intl.DateTimeFormatOptions = {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    };

    const currentTime = now.toLocaleTimeString('pt-BR', spTimeOpts);

    const spDateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

    const startOfDay = new Date(`${spDateStr}T00:00:00-03:00`);
    const endOfDay   = new Date(`${spDateStr}T23:59:59-03:00`);

    // =========================
    // 🟢 ABERTURA
    // =========================
    const openingRestaurants = await prisma.restaurant.findMany({
      where: {
        openTime: { lte: currentTime },
        openedToday: false
      }
    });

    for (const restaurant of openingRestaurants) {
      await prisma.product.updateMany({
        where: { restaurantId: restaurant.id, category: 'prato' },
        data: { available: true }
      });

      await prisma.restaurant.update({
        where: { id: restaurant.id },
        data: { openedToday: true, closedToday: false }
      });
    }

    // =========================
    // 🔴 FECHAMENTO
    // =========================
    const closingRestaurants = await prisma.restaurant.findMany({
      where: {
        closeTime: { lte: currentTime },
        closedToday: false
      }
    });

    for (const restaurant of closingRestaurants) {

      // 🔻 Oculta pratos
      await prisma.product.updateMany({
        where: { restaurantId: restaurant.id, category: 'prato' },
        data: { available: false }
      });

      // =========================
      // 📊 RELATÓRIO (igual ao seu)
      // =========================
      if (restaurant.whatsapp) {

        const dailyOrders = await prisma.order.findMany({
          where: {
            restaurantId: restaurant.id,
            createdAt: { gte: startOfDay, lte: endOfDay }
          }
        });

        let faturamento = { cafe: 0, almoco: 0, janta: 0, outros: 0 };
        let qtdPedidos  = { cafe: 0, almoco: 0, janta: 0, outros: 0 };
        let totalGeral  = 0;

        const timeToMinutes = (t: string) => {
          const [h, m] = t.split(':').map(Number);
          return (h * 60) + m;
        };

        const limites = {
          cafe:   [timeToMinutes(restaurant.cafeStart),   timeToMinutes(restaurant.cafeEnd)],
          almoco: [timeToMinutes(restaurant.almocoStart), timeToMinutes(restaurant.almocoEnd)],
          janta:  [timeToMinutes(restaurant.jantaStart),  timeToMinutes(restaurant.jantaEnd)]
        };

        dailyOrders.forEach((order: any) => {
          const orderTimeStr = new Date(order.createdAt).toLocaleTimeString('pt-BR', spTimeOpts);
          const orderMins = timeToMinutes(orderTimeStr);

          if (orderMins >= limites.cafe[0] && orderMins <= limites.cafe[1]) {
            faturamento.cafe += order.total; qtdPedidos.cafe++;
          } else if (orderMins >= limites.almoco[0] && orderMins <= limites.almoco[1]) {
            faturamento.almoco += order.total; qtdPedidos.almoco++;
          } else if (orderMins >= limites.janta[0] && orderMins <= limites.janta[1]) {
            faturamento.janta += order.total; qtdPedidos.janta++;
          } else {
            faturamento.outros += order.total; qtdPedidos.outros++;
          }

          totalGeral += order.total;
        });

        const reportMsg =
          `📊 *FECHAMENTO DE CAIXA DIÁRIO* 📊\n` +
          `Restaurante: *${restaurant.name}*\n` +
          `Data: ${now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n\n` +
          `☕ *Café da Manhã:*\nPedidos: ${qtdPedidos.cafe} | R$ ${faturamento.cafe.toFixed(2).replace('.', ',')}\n\n` +
          `🍛 *Almoço:*\nPedidos: ${qtdPedidos.almoco} | R$ ${faturamento.almoco.toFixed(2).replace('.', ',')}\n\n` +
          `🌙 *Jantar:*\nPedidos: ${qtdPedidos.janta} | R$ ${faturamento.janta.toFixed(2).replace('.', ',')}\n\n` +
          (qtdPedidos.outros > 0 ? `🕑 Fora de Hora: R$ ${faturamento.outros.toFixed(2).replace('.', ',')}\n\n` : '') +
          `💵 *TOTAL:* R$ ${totalGeral.toFixed(2).replace('.', ',')} (${dailyOrders.length} pedidos)\n\n` +
          `_Operação encerrada._ 🚀`;

        await sendWhatsAppMessage(restaurant, restaurant.whatsapp, reportMsg);
      }

      // 🔒 marca como fechado
      await prisma.restaurant.update({
        where: { id: restaurant.id },
        data: { closedToday: true }
      });
    }

    res.json({ success: true });

  } catch (error) {
    console.error("Erro no cron:", error);
    res.status(500).json({ error: "erro cron" });
  }
});

// ============================================================================
// 🔄 CRON RESET: Zera flags de abertura/fechamento à meia-noite (00:00)
// ============================================================================
app.post('/cron/reset', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(403).json({ error: "forbidden" });
  }

  try {
    await prisma.restaurant.updateMany({
      data: { openedToday: false, closedToday: false }
    });
    console.log("[SIAA] 🔄 Reset diário de openedToday/closedToday executado.");
    res.json({ success: true });
  } catch (error) {
    console.error("Erro no cron/reset:", error);
    res.status(500).json({ error: "erro cron/reset" });
  }
});

// IDENTIFICADOR DE SUBDOMÍNIO (Descobre de qual segmento o cliente é)
app.get('/api/v1/public/tenant/identify/:slug', async (req: ExpressRequest, res: Response) => {
  try {
    const slug = req.params.slug as string;
    
    // Procura em Restaurantes
    const rest = await prisma.restaurant.findUnique({ where: { slug }, select: { id: true } });
    if (rest) return res.json({ segment: 'restaurant' });

    // Procura em Lojas/Varejo
    const store = await prisma.store.findUnique({ where: { slug }, select: { id: true } });
    if (store) return res.json({ segment: 'retail' });

    // Procura em Serviços/Agendamentos
    const serv = await prisma.service.findUnique({ where: { slug }, select: { id: true } });
    if (serv) return res.json({ segment: 'service' });

    return res.status(404).json({ error: 'Estabelecimento não encontrado' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao identificar estabelecimento' });
  }
});

// ============================================================================
// Rotas dos Restaurantes 
// ============================================================================

app.post('/api/v1/upload', authenticateToken, upload.single('file'), (req: ExpressRequest, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado." });
    res.json({ url: req.file.path });
  } catch (error) {
    res.status(500).json({ error: "Erro ao fazer upload do arquivo." });
  }
});

app.get('/api/v1/restaurant/:slug', async (req: ExpressRequest, res: Response) => {
  const { slug } = req.params;
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { slug: slug as string },
      include: { products: true }
    });

    if (!restaurant) return res.status(404).json({ error: "Estabelecimento não encontrado" });

    // Remove campos sensíveis antes de enviar para o público
    const { evolutionApiKey, evolutionInstance, ...publicData } = restaurant;
    res.json(publicData);
  } catch (error) {
    res.status(500).json({ error: "Erro interno no servidor" });
  }
});

// ============================================================================
// 👤 CUSTOMER LOOKUP — Autocomplete por telefone
// ============================================================================
app.get('/api/v1/customer/:phone', orderLimiter, async (req: ExpressRequest, res: Response) => {
  const { phone } = req.params;
  const restaurantId = req.query.restaurantId as string | undefined;

  if (!phone || !restaurantId) {
    return res.status(400).json({ error: 'phone e restaurantId são obrigatórios.' });
  }

  try {
    const phoneDigits = (phone as string).replace(/\D/g, '');

    // Busca todos do restaurante e filtra por telefone normalizado em memória
    const allOrders = await prisma.order.findMany({
      where: { restaurantId: restaurantId as string },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { items: true },
    });

    const orders = allOrders
      .filter(o => o.customerPhone.replace(/\D/g, '') === phoneDigits)
      .slice(0, 3);

    if (orders.length === 0) {
      return res.status(404).json({ found: false });
    }

    const lastOrders = orders.map(order => ({
      id: order.id,
      createdAt: order.createdAt,
      total: order.total,
      status: order.status,
      items: order.items.map((i: any) => ({
        name: i.name,
        quantity: i.quantity,
        price: i.price,
        variation: i.variation || undefined,      
      })),
    }));

    // Último endereço de entrega (ignora retiradas)
    const lastOrderWithAddress = orders.find(o =>
      o.address && o.address !== 'Retirada no Local'
    );
    const lastAddress = lastOrderWithAddress?.address || null;

    // Extrai bairro — formato salvo: "Bairro - Rua, Nº - Referência"
    let lastNeighborhood: string | null = null;
    if (lastAddress) {
      const parts = lastAddress.split(' - ');
      if (parts.length >= 3) lastNeighborhood = parts[0].trim();
    }

    res.json({ found: true, name: orders[0].customerName, lastOrders, lastAddress, lastNeighborhood });

  } catch (error) {
    console.error('[SIAA] Erro no customer lookup:', error);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

app.post('/api/v1/order', orderLimiter, async (req: ExpressRequest, res: Response) => {
  const { restaurantId, cart, customerData, total } = req.body;

  try {
    // 1. VERIFICAÇÃO DE ESTOQUE FACULTATIVO/OPCIONAL
    for (const item of cart) {
      if (item.productId) {
        const prod = await prisma.product.findUnique({ where: { id: item.productId } });
        // Se o stock não for null, o controle está ativo para este produto
        if (prod && prod.stock !== null) {
          if (prod.stock < (item.quantity || 1)) {
            return res.status(400).json({ error: `Estoque esgotado para o item: ${prod.name}` });
          }
        }
      }
    }

    // 2. CRIAÇÃO DO PEDIDO
    const savedOrder = await prisma.order.create({
      data: {
        restaurantId,
        customerName: customerData.name,
        customerPhone: customerData.phone,
        orderType: customerData.orderType,
        address: customerData.address || null,
        paymentMethod: customerData.paymentMethod,
        changeFor: (customerData.paymentMethod === 'money' || customerData.paymentMethod === 'cash') && customerData.changeFor
          ? Number(customerData.changeFor)
          : null,
        total,
        status: 'pending',
        items: {
          create: cart.map((i: any) => ({
            name: i.name,
            quantity: i.quantity || 1,
            price: Number(i.price),
            variation: i.variation || null,
            addOns: i.addOns || [],
          })),
        },
      },
      include: { items: true },
    });

    // 3. DECREMENTAR O ESTOQUE APÓS SUCESSO (SE ATIVO)
    for (const item of cart) {
      if (item.productId) {
        const prod = await prisma.product.findUnique({ where: { id: item.productId } });
        if (prod && prod.stock !== null) {
          await prisma.product.update({
            where: { id: item.productId },
            data: { stock: { decrement: item.quantity || 1 } }
          });
        }
      }
    }

    const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restaurant) return res.status(404).json({ error: "Restaurante inválido" });

    const orderTypeBR = customerData.orderType === 'delivery' ? 'Entrega 🛵' : 'Retirada 🏠';
    const paymentBR = customerData.paymentMethod === 'pix' ? 'Pix' :
                      customerData.paymentMethod === 'card' ? 'Cartão' : 'Dinheiro';

    const changeForNum = customerData.changeFor ? Number(customerData.changeFor) : null;
    const changeLine = (customerData.paymentMethod === 'money' || customerData.paymentMethod === 'cash')
      ? changeForNum
        ? `\n💵 *Troco para:* R$ ${changeForNum.toFixed(2).replace('.', ',')} (devolve R$ ${Math.max(0, changeForNum - total).toFixed(2).replace('.', ',')})`
        : `\n💵 *Troco:* Não precisa`
      : '';

    const itemsListTxt = cart.map((i: any) => {
      return `- ${i.quantity || 1}x ${i.name} (R$ ${(Number(i.price) * (i.quantity || 1)).toFixed(2).replace('.', ',')})`;
    }).join('\n');

    const ownerMsg = `*NOVO PEDIDO - ${restaurant.name}*\n\n` +
                     `👤 *Cliente:* ${customerData.name}\n` +
                     `📱 *WhatsApp:* ${customerData.phone}\n` +
                     `📦 *Tipo:* ${orderTypeBR}\n` +
                     `📍 *Endereço:* ${customerData.address || 'N/A'}\n` +
                     `💳 *Pagamento:* ${paymentBR}${changeLine}\n` +
                     `💰 *Total:* R$ ${total.toFixed(2).replace('.', ',')}\n\n` +
                     `🛒 *Itens:*\n${itemsListTxt}`;

    const customerMsg = `Olá, *${customerData.name}*! 👋\n\n` +
                        `Recebemos o seu pedido com sucesso! 🎉\n\n` +
                        `🛒 *Seu Pedido:*\n${itemsListTxt}\n\n` +
                        `💰 *Total:* R$ ${total.toFixed(2).replace('.', ',')} (${paymentBR})${changeLine}\n` +
                        `📦 *Forma:* ${orderTypeBR}\n\n` +
                        `⏱️ *Tempo estimado:* 30-60 min\n\n` +
                        `Já enviamos para a nossa cozinha e logo começaremos o preparo! 👨‍🍳 Avisaremos por aqui qualquer mudança no status do seu pedido.`;

    if (restaurant.whatsapp) {
      await sendWhatsAppMessage(restaurant, restaurant.whatsapp, ownerMsg, customerData.receiptUrl);
    }
    if (customerData.phone) {
      await sendWhatsAppMessage(restaurant, customerData.phone, customerMsg);
    }

    res.status(200).json({ success: true, orderId: savedOrder.id });
  } catch (error) {
    res.status(500).json({ error: "Falha ao processar pedido" });
  }
}); 

app.get('/api/v1/siaa-admin/pdv/orders', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const spDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const startOfDay = new Date(`${spDateStr}T00:00:00-03:00`);
    const endOfDay = new Date(`${spDateStr}T23:59:59-03:00`);

    const orders = await prisma.order.findMany({
      where: { 
        restaurantId: req.restaurantId,
        createdAt: { gte: startOfDay, lte: endOfDay }
      },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });

    res.json(orders);
  } catch (error) {
    console.error("Erro ao carregar PDV:", error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── SSE — mapa de clientes ouvindo por orderId ────────────────────────────
const sseClients = new Map<string, Set<Response>>();

function sseEmit(orderId: string, data: object) {
  const clients = sseClients.get(orderId);
  if (!clients) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => { try { res.write(payload); } catch {} });
}

// Endpoint SSE — cliente conecta aqui para ouvir atualizações do pedido
app.get('/api/v1/order/:orderId/status-stream', async (req: ExpressRequest, res: Response) => {
  const orderId = req.params.orderId as string;

  // Busca status inicial
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
  if (!order) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx: desativa buffer
  res.flushHeaders();

  // Envia status atual imediatamente
  res.write(`data: ${JSON.stringify({ status: order.status })}\n\n`);

  // Registra o cliente
  if (!sseClients.has(orderId)) sseClients.set(orderId, new Set());
  sseClients.get(orderId)!.add(res);

  // Remove quando o cliente desconectar
  req.on('close', () => {
    sseClients.get(orderId)?.delete(res);
    if (sseClients.get(orderId)?.size === 0) sseClients.delete(orderId);
  });
});

app.patch('/api/v1/siaa-admin/pdv/orders/:orderId/status', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const order = await prisma.order.findUnique({ 
      where: { id: req.params.orderId as string },
      include: { restaurant: true }
    });
    
    if (!order || order.restaurantId !== req.restaurantId) return res.status(403).json({ error: 'Negado' });
    
    const newStatus = req.body.status;

    const updated = await prisma.order.update({
      where: { id: req.params.orderId as string },
      data: { status: newStatus },
      include: { items: true },
    });

    // Envio automático para o cliente quando o pedido está "Pronto"
    if (newStatus === 'ready') {
      let statusMsg = "";
      if (order.orderType === 'delivery') {
        statusMsg = `Boas notícias, *${order.customerName}*! 🛵💨\n\n` +
                    `Seu pedido acabou de *sair para entrega* e está a caminho do endereço:\n` +
                    `📍 _${order.address}_\n\n` +
                    `Agradecemos a preferência e bom apetite! ☺️`;
      } else if (order.orderType === 'pickup') {
        statusMsg = `Boas notícias, *${order.customerName}*!\n\n` +
                    `Seu pedido *já está pronto* e embalado!\n` +
                    `Você já pode vir retirar no balcão.\n\n` +
                    `Agradecemos a preferência! ☺️`;
      }
      if (statusMsg && order.customerPhone) {
        await sendWhatsAppMessage(order.restaurant, order.customerPhone, statusMsg);
      }
    }
    
    // Empurra atualização para todos os clientes ouvindo esse pedido
    sseEmit(req.params.orderId as string, { status: newStatus });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Erro' });
  }
});

app.post('/api/v1/siaa-admin/register', async (req: ExpressRequest, res: Response) => {
  const { name, slug, email, password, segment } = req.body;
 
  if (!['restaurant', 'retail', 'service'].includes(segment)) {
    return res.status(400).json({ error: 'Segmento inválido.' });
  }
 
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const uniqueInstanceName = `logos_${slug}_${Date.now().toString().slice(-4)}`;
 
    // ── Campos base de Evolution (iguais pra todos) ──
    const evoBase = {
      evolutionInstance: uniqueInstanceName,
      evolutionApiKey: 'pending',
    };
 
    // ── 1. Cria o estabelecimento no model correto ──
    let establishmentId: string;
 
    if (segment === 'restaurant') {
      const r = await prisma.restaurant.create({ data: { name, slug, ...evoBase } });
      establishmentId = r.id;
    } else if (segment === 'retail') {
      const s = await prisma.store.create({ data: { name, slug, ...evoBase } });
      establishmentId = s.id;
    } else {
      // service
      const sv = await prisma.service.create({ data: { name, slug, ...evoBase } });
      establishmentId = sv.id;
    }
 
    // ── 2. Cria o AdminUser vinculado ──
    await prisma.adminUser.create({
      data: {
        email,
        password: hashedPassword,
        segment,
        // Só preenche a FK do segmento correto
        ...(segment === 'restaurant' && { restaurantId: establishmentId }),
        ...(segment === 'retail'     && { storeId:      establishmentId }),
        ...(segment === 'service'    && { serviceId:    establishmentId }),
      }
    });
 
    // ── 3. Cria a instância Evolution (best-effort) ──
    try {
      const evoRes = await fetch(`${evolutionBaseUrl}/instance/create`, {
        method: 'POST',
        headers: {
          'apikey': process.env.EVOLUTION_GLOBAL_KEY as string,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          instanceName: uniqueInstanceName,
          qrcode: true,
          integration: 'WHATSAPP-BAILEYS'
        })
      });
 
      const evoData = await evoRes.json();
      const apiKey = evoData?.hash?.apikey
        || evoData?.instance?.apikey
        || process.env.EVOLUTION_GLOBAL_KEY;
 
      // Atualiza a apiKey no model correto
      if (segment === 'restaurant') {
        await prisma.restaurant.update({ where: { slug }, data: { evolutionApiKey: apiKey } });
      } else if (segment === 'retail') {
        await prisma.store.update({ where: { slug }, data: { evolutionApiKey: apiKey } });
      } else {
        await prisma.service.update({ where: { slug }, data: { evolutionApiKey: apiKey } });
      }
 
      // Desativa webhook
      await fetch(`${evolutionBaseUrl}/webhook/set/${uniqueInstanceName}`, {
        method: 'POST',
        headers: { 'apikey': apiKey as string, 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook: { enabled: false, url: '', events: [] } })
      });
    } catch (evoErr: any) {
      console.error('Erro Evolution (não crítico):', evoErr.message);
    }
 
    res.status(201).json({ message: 'Cliente criado com sucesso.' });
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'E-mail ou slug já cadastrado.' });
    }
    res.status(500).json({ error: error.message });
  }
});
  
app.get('/api/v1/siaa-admin/whatsapp/connect', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({ where: { id: req.restaurantId } });
    if (!restaurant) return res.status(404).json({ error: "Não encontrado" });

    const response = await fetch(`${evolutionBaseUrl}/instance/connect/${restaurant.evolutionInstance}`, {
      method: 'GET',
      headers: { 'apikey': restaurant.evolutionApiKey }
    });

    res.json(await response.json());
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/v1/siaa-admin/login', loginLimiter, async (req: ExpressRequest, res: Response) => {
  const { email, password } = req.body;
 
  try {
    const user = await prisma.adminUser.findUnique({ where: { email } });
 
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
    }
 
    // O ID do estabelecimento varia conforme o segment
    const establishmentId =
      user.restaurantId ?? user.storeId ?? user.serviceId ?? '';
 
    const token = jwt.sign(
      {
        adminId:         user.id,
        establishmentId, // ID do restaurante / loja / serviço
        segment:         user.segment,
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
 
    res.json({
      token,
      segment:         user.segment,
      establishmentId,
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ROTA PARA LER O STATUS (O PDV CHAMA ISSO NO CARREGAMENTO)
app.get('/api/v1/siaa-admin/restaurant/pause', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({ 
      where: { id: req.restaurantId },
      select: { isPaused: true } 
    });
    
    if (!restaurant) return res.status(404).json({ error: "Restaurante não encontrado" });
    
    res.json({ isPaused: restaurant.isPaused });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar status' });
  }
});

// SUA ROTA DE ATUALIZAR (MANTENHA ESSA QUE VOCÊ JÁ FEZ)
app.put('/api/v1/siaa-admin/restaurant/pause', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { isPaused } = req.body;
    const updated = await prisma.restaurant.update({  
      where: { id: req.restaurantId },
      data: { isPaused }
    });
    res.json({ success: true, isPaused: updated.isPaused });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao pausar operação' });
  }
});

app.get('/api/v1/siaa-admin/me', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({ where: { id: req.restaurantId }, include: { products: true } });
    if (!restaurant) return res.status(404).json({ error: "Não encontrado" });
    res.json(restaurant);
  } catch (error) {
    res.status(500).json({ error: "Erro" });
  }
});

app.put('/api/v1/siaa-admin/restaurant', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const updateData = { ...req.body };
    delete updateData.id;
    delete updateData.password;
    delete updateData.evolutionApiKey;
    delete updateData.evolutionInstance;
    await prisma.restaurant.update({ where: { id: req.restaurantId }, data: updateData });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Erro" });
  }
});

app.post('/api/v1/siaa-admin/products', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    res.status(201).json(await prisma.product.create({
      data: { ...req.body, restaurantId: req.restaurantId!, available: req.body.available || false, timeSlot: req.body.timeSlot || 'sempre' }
    }));
  } catch (error) {
    res.status(500).json({ error: "Erro" });
  }
});

app.put('/api/v1/siaa-admin/products/reorder', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { order } = req.body;
    await Promise.all(
      order.map((item: { id: string; order: number }) =>
        prisma.product.update({
          where: { id: item.id },
          data: { order: item.order },
        })
      )
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao reordenar produtos' });
  }
});

app.put('/api/v1/siaa-admin/products/:productId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.productId as string } });
    if (!product || product.restaurantId !== req.restaurantId) return res.status(403).json({ error: "Negado" });
    res.json(await prisma.product.update({ where: { id: req.params.productId as string }, data: req.body }));
  } catch (error) {
    res.status(500).json({ error: "Erro" });
  }
});

app.delete('/api/v1/siaa-admin/products/:productId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    await prisma.product.delete({ where: { id: req.params.productId as string } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Erro" });
  }
});

// ============================================================================
// Rotas dos Serviços de Agendamento
// ============================================================================

app.get('/api/v1/public/tenant/:slug', async (req: ExpressRequest, res: Response) => {
  try {
    const slug = req.params.slug as string;
    
    const serviceTenant = await prisma.service.findUnique({
      where: { slug },
      include: {
        products: {
          where: { available: true },
          orderBy: { order: 'asc' }
        }
      }
    });

    if (serviceTenant) {
      return res.json(serviceTenant);
    }

    return res.status(404).json({ error: 'Estabelecimento não encontrado' });
  } catch (error) {
    console.error("Erro ao buscar tenant:", error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// 2. BUSCAR DADOS DO ESTABELECIMENTO DE SERVIÇO (ME)
app.get('/api/v1/siaa-admin/service/me', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const serviceId = req.serviceId as string; 

    const serviceData = await prisma.service.findUnique({
      where: { id: serviceId },
      include: {
        products: {
          orderBy: { order: 'asc' }
        }
      }
    });

    if (!serviceData) return res.status(404).json({ error: 'Serviço não encontrado' });
    res.json(serviceData);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar dados do estabelecimento' });
  }
});

// 3. ATUALIZAR DADOS DO ESTABELECIMENTO DE SERVIÇO
app.put('/api/v1/siaa-admin/service', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const serviceId = req.serviceId as string;
    const {
      name, slug, logo, bannerImage, bannerTitle, bannerSubtitle,
      whatsapp, pixKey, operatingDays, openTime, closeTime, categories
    } = req.body;

    const updatedService = await prisma.service.update({
      where: { id: serviceId },
      data: {
        name, slug, logo, bannerImage, bannerTitle, bannerSubtitle,
        whatsapp, pixKey, operatingDays, openTime, closeTime, 
        categories: categories ? categories : undefined
      }
    });

    res.json(updatedService);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar estabelecimento' });
  }
});

// 4. CRIAR NOVO SERVIÇO/PRODUTO
app.post('/api/v1/siaa-admin/service-products', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const serviceId = req.serviceId as string;
    const { name, description, price, durationMin, image, category, available } = req.body;

    const newProduct = await prisma.serviceProduct.create({
      data: {
        name, description, price, image, category, available,
        durationMin: durationMin || 30,
        serviceId
      }
    });

    res.status(201).json(newProduct);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar serviço' });
  }
});

// 5. ATUALIZAR SERVIÇO/PRODUTO
app.put('/api/v1/siaa-admin/service-products/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string; // <-- Corrige o erro "string | string[]"
    const { name, description, price, durationMin, image, category, available } = req.body;

    const updatedProduct = await prisma.serviceProduct.update({
      where: { id },
      data: { name, description, price, durationMin, image, category, available }
    });

    res.json(updatedProduct);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar serviço' });
  }
});

// 6. EXCLUIR SERVIÇO/PRODUTO
app.delete('/api/v1/siaa-admin/service-products/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string; // <-- Corrige o erro "string | string[]"
    await prisma.serviceProduct.delete({ where: { id } });
    res.json({ message: 'Serviço excluído com sucesso' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao excluir serviço' });
  }
});

// 7. LISTAR AGENDAMENTOS
app.get('/api/v1/siaa-admin/appointments', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const serviceId = req.serviceId as string;
    
    const appointments = await prisma.appointment.findMany({
      where: { serviceId },
      include: { items: true },
      orderBy: { scheduledAt: 'asc' }
    });

    res.json(appointments);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar agenda' });
  }
});

// 8. ATUALIZAR STATUS DO AGENDAMENTO
app.patch('/api/v1/siaa-admin/appointments/:id/status', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string; // <-- Corrige o erro "string | string[]"
    const { status } = req.body; 

    const updatedAppointment = await prisma.appointment.update({
      where: { id },
      data: { status }
    });

    res.json(updatedAppointment);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar status do agendamento' });
  }
});

// 9. REORDENAR SERVIÇOS
app.put('/api/v1/siaa-admin/service-products/reorder', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { order } = req.body;
    await Promise.all(
      order.map((item: { id: string; order: number }) =>
        prisma.serviceProduct.update({
          where: { id: item.id },
          data: { order: item.order },
        })
      )
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao reordenar produtos' });
  }
});

app.post('/api/v1/public/appointments', async (req: ExpressRequest, res: Response) => {
  try {
    const { tenantId, customerName, customerPhone, date, time, services, total } = req.body;
    
    // Converte a data (YYYY-MM-DD) e hora (HH:mm) para o formato DateTime real
    const scheduledAt = new Date(`${date}T${time}:00-03:00`); 

    const appointment = await prisma.appointment.create({
      data: {
        serviceId: tenantId,
        customerName,
        customerPhone,
        paymentMethod: 'A Combinar na Loja',
        total,
        status: 'pending',
        scheduledAt, // <-- Aqui está o segredo do Horário Real!
        items: {
          create: services.map((s: any) => ({
            name: s.name,
            quantity: 1,
            price: s.price
          }))
        }
      }
    });

    res.status(201).json(appointment);
  } catch (error) {
    console.error("Erro ao criar agendamento:", error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.listen(3001, () => console.log("Backend rodando sem erros"));
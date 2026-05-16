// src/server.ts
import 'dotenv/config'; 
import express, { Request as ExpressRequest, Response, NextFunction } from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';
import { CloudinaryStorage } from 'multer-storage-cloudinary';

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());

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

const JWT_SECRET = process.env.JWT_SECRET || 'chave_super_secreta_logos_tec';
const evolutionBaseUrl = process.env.EVOLUTION_URL?.replace(/\/$/, '');

interface AuthRequest extends ExpressRequest {
  restaurantId?: string;
}

const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: "Acesso negado." });

  jwt.verify(token, JWT_SECRET, (err: any, decoded: any) => {
    if (err) return res.status(403).json({ error: "Token inválido ou expirado." });
    req.restaurantId = decoded.id;
    next();
  });
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

  console.log(`[SIAA] 📡 Enviando WhatsApp para: ${numeroFinal}`);

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
setInterval(async () => {
  try {
    const now = new Date();
    const spTimeOpts: Intl.DateTimeFormatOptions = { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false };
    const currentTime = now.toLocaleTimeString('pt-BR', spTimeOpts);

    // 1. ROTINA DE ABERTURA: Reativa os pratos automaticamente no horário de abertura do restaurante
    const openingRestaurants = await prisma.restaurant.findMany({
      where: { openTime: currentTime }
    });

    for (const restaurant of openingRestaurants) {
      await prisma.product.updateMany({
        where: { restaurantId: restaurant.id, category: 'prato' },
        data: { available: true }
      });
    }

    // 2. ROTINA DE FECHAMENTO: Oculta os pratos e gera o Relatório de Caixa
    const closingRestaurants = await prisma.restaurant.findMany({
      where: { closeTime: currentTime }
    });

    for (const restaurant of closingRestaurants) {
      // Oculta pratos do cardápio
      await prisma.product.updateMany({
        where: { restaurantId: restaurant.id, category: 'prato' },
        data: { available: false }
      });

      // Fechamento de Caixa (Relatório WhatsApp)
      if (restaurant.whatsapp) {
        const spDateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
        const startOfDay = new Date(`${spDateStr}T00:00:00-03:00`);
        const endOfDay = new Date(`${spDateStr}T23:59:59-03:00`);

        const dailyOrders = await prisma.order.findMany({
          where: {
            restaurantId: restaurant.id,
            createdAt: { gte: startOfDay, lte: endOfDay }
          }
        });

        let faturamento = { cafe: 0, almoco: 0, janta: 0, outros: 0 };
        let qtdPedidos = { cafe: 0, almoco: 0, janta: 0, outros: 0 };
        let totalGeral = 0;

        const timeToMinutes = (t: string) => {
          const [h, m] = t.split(':').map(Number);
          return (h * 60) + m;
        };

        const limites = {
          cafe: [timeToMinutes(restaurant.cafeStart), timeToMinutes(restaurant.cafeEnd)],
          almoco: [timeToMinutes(restaurant.almocoStart), timeToMinutes(restaurant.almocoEnd)],
          janta: [timeToMinutes(restaurant.jantaStart), timeToMinutes(restaurant.jantaEnd)]
        };

        dailyOrders.forEach(order => {
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

        const reportMsg = `📊 *FECHAMENTO DE CAIXA DIÁRIO* 📊\n` +
                          `Restaurante: *${restaurant.name}*\n` +
                          `Data: ${now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n\n` +
                          `☕ *Café da Manhã:*\n` +
                          `Pedidos: ${qtdPedidos.cafe} | Faturamento: R$ ${faturamento.cafe.toFixed(2).replace('.', ',')}\n\n` +
                          `🍛 *Almoço:*\n` +
                          `Pedidos: ${qtdPedidos.almoco} | Faturamento: R$ ${faturamento.almoco.toFixed(2).replace('.', ',')}\n\n` +
                          `🌙 *Jantar:*\n` +
                          `Pedidos: ${qtdPedidos.janta} | Faturamento: R$ ${faturamento.janta.toFixed(2).replace('.', ',')}\n\n` +
                          (qtdPedidos.outros > 0 ? `🕑 *Fora de Hora:* R$ ${faturamento.outros.toFixed(2).replace('.', ',')}\n\n` : '') +
                          `💵 *TOTAL GERAL:* R$ ${totalGeral.toFixed(2).replace('.', ',')} (${dailyOrders.length} pedidos)\n\n` +
                          `_Operação encerrada. Bom descanso!_ 🚀`;

        await sendWhatsAppMessage(restaurant, restaurant.whatsapp, reportMsg);
      }
    }
  } catch (error) {
    console.error("Erro na rotina de fechamento de caixa:", error);
  }
}, 60000);

// ============================================================================
// 🚀 ENDPOINTS DA API
// ============================================================================

app.post('/api/v1/upload', upload.single('file'), (req: ExpressRequest, res: Response) => {
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

    if (!restaurant) return res.status(404).json({ error: "Restaurante não encontrado" });

    const { evolutionApiKey, evolutionInstance, password, email, ...publicData } = restaurant;
    res.json(publicData);
  } catch (error) {
    res.status(500).json({ error: "Erro interno no servidor" });
  }
});

app.post('/api/v1/order', async (req: ExpressRequest, res: Response) => {
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

    const itemsListTxt = cart.map((i: any) => {
      return `- ${i.quantity || 1}x ${i.name} (R$ ${(Number(i.price) * (i.quantity || 1)).toFixed(2).replace('.', ',')})`;
    }).join('\n');

    const ownerMsg = `*NOVO PEDIDO - ${restaurant.name}*\n\n` +
                     `👤 *Cliente:* ${customerData.name}\n` +
                     `📱 *WhatsApp:* ${customerData.phone}\n` +
                     `📦 *Tipo:* ${orderTypeBR}\n` +
                     `📍 *Endereço:* ${customerData.address || 'N/A'}\n` +
                     `💳 *Pagamento:* ${paymentBR}\n` +
                     `💰 *Total:* R$ ${total.toFixed(2).replace('.', ',')}\n\n` +
                     `🛒 *Itens:*\n${itemsListTxt}`;

    const customerMsg = `Olá, *${customerData.name}*! 👋\n\n` +
                        `Recebemos o seu pedido com sucesso! 🎉\n\n` +
                        `🛒 *Seu Pedido:*\n${itemsListTxt}\n\n` +
                        `💰 *Total:* R$ ${total.toFixed(2).replace('.', ',')} (${paymentBR})\n` +
                        `📦 *Forma:* ${orderTypeBR}\n\n` +
                        `⏱️ *Tempo estimado:* 30-60 min\n\n` +
                        `Já enviamos para a nossa cozinha e logo começaremos o preparo! 👨‍🍳 Avisaremos por aqui qualquer mudança no status do seu pedido.`;

    if (restaurant.whatsapp) {
      await sendWhatsAppMessage(restaurant, restaurant.whatsapp, ownerMsg, customerData.receiptUrl);
    }
    if (customerData.phone) {
      await sendWhatsAppMessage(restaurant, customerData.phone, customerMsg);
    }

    res.status(200).json({ success: true });
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
                    `Agradecemos a preferência e bom apetite! 🍽️`;
      } else if (order.orderType === 'pickup') {
        statusMsg = `Boas notícias, *${order.customerName}*! 🏠✨\n\n` +
                    `Seu pedido *já está pronto* e embalado!\n` +
                    `Você já pode vir retirar no balcão.\n\n` +
                    `Agradecemos a preferência! 🍽️`;
      }
      if (statusMsg && order.customerPhone) {
        await sendWhatsAppMessage(order.restaurant, order.customerPhone, statusMsg);
      }
    }
    
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Erro' });
  }
});

app.post('/api/v1/siaa-admin/register', async (req: ExpressRequest, res: Response) => {
  const { name, slug, email, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const uniqueInstanceName = `logos_${slug}_${Date.now().toString().slice(-4)}`;

    const newRestaurant = await prisma.restaurant.create({
      data: { name, slug, email, password: hashedPassword, evolutionInstance: uniqueInstanceName, evolutionApiKey: 'pending' }
    });

    try {
      const evoRes = await fetch(`${evolutionBaseUrl}/instance/create`, {
        method: 'POST',
        headers: { 'apikey': process.env.EVOLUTION_GLOBAL_KEY as string, 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceName: uniqueInstanceName, qrcode: true, integration: "WHATSAPP-BAILEYS" })
      });

      const evoData = await evoRes.json();
      const apiKey = evoData?.hash?.apikey || evoData?.instance?.apikey || process.env.EVOLUTION_GLOBAL_KEY;

      await prisma.restaurant.update({ where: { id: newRestaurant.id }, data: { evolutionApiKey: apiKey } });
    } catch (evoErr: any) {
      console.error("Erro na criação remota:", evoErr.message);
    }
    res.status(201).json({ message: "Sucesso" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/v1/siaa-admin/whatsapp/status', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({ where: { id: req.restaurantId } });
    if (!restaurant) return res.status(404).json({ error: "Não encontrado" });

    const response = await fetch(`${evolutionBaseUrl}/instance/fetchInstances`, {
      method: 'GET',
      headers: { 'apikey': restaurant.evolutionApiKey }
    });
    const data = await response.json();
    // A Evolution API retorna um array; busca a instância pelo nome
    const instance = Array.isArray(data)
      ? data.find((i: any) => i.instance?.instanceName === restaurant.evolutionInstance)
      : data;
    const state = instance?.instance?.state || instance?.state || 'unknown';
    res.json({ connected: state === 'open', state });
  } catch (error: any) {
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

app.post('/api/v1/siaa-admin/login', async (req: ExpressRequest, res: Response) => {
  const { email, password } = req.body;
  try {
    const restaurant = await prisma.restaurant.findUnique({ where: { email } });
    if (!restaurant || !(await bcrypt.compare(password, restaurant.password))) return res.status(401).json({ error: "Inválido" });
    res.json({ token: jwt.sign({ id: restaurant.id, slug: restaurant.slug }, JWT_SECRET, { expiresIn: '24h' }), restaurantId: restaurant.id, slug: restaurant.slug });
  } catch (error) {
    res.status(500).json({ error: "Erro" });
  }
});

app.get('/api/v1/siaa-admin/me', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({ where: { id: req.restaurantId }, include: { products: true } });
    if (!restaurant) return res.status(404).json({ error: "Não encontrado" });
    const { password, ...safeData } = restaurant;
    res.json(safeData);
  } catch (error) {
    res.status(500).json({ error: "Erro" });
  }
});

app.put('/api/v1/siaa-admin/restaurant', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const updateData = { ...req.body };
    delete updateData.id;
    delete updateData.password;
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

app.listen(3001, () => console.log("🚀 LOGOS SIAA API Rodando na Oracle (Conectada à Hostinger)"));

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

setInterval(async () => {
  try {
    const now = new Date();
    const currentTime = now.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false });

    const closingRestaurants = await prisma.restaurant.findMany({
      where: { closeTime: currentTime }
    });

    for (const restaurant of closingRestaurants) {
      await prisma.product.updateMany({
        where: { restaurantId: restaurant.id, category: 'prato' },
        data: { available: false }
      });
    }
  } catch (error) {
    console.error("Erro na rotina de zerar pratos:", error);
  }
}, 60000);

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
          size: i.size || null,
        })),
      },
    },
    include: { items: true },
  });

  try {
    const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restaurant) return res.status(404).json({ error: "Restaurante inválido" });

    const orderTypeBR = customerData.orderType === 'delivery' ? 'Entrega 🛵' : 'Retirada 🏠';
    const paymentBR = customerData.paymentMethod === 'pix' ? 'Pix' :
                      customerData.paymentMethod === 'card' ? 'Cartão' : 'Dinheiro';

    const messageText = `*NOVO PEDIDO - ${restaurant.name}*\n\n` +
                        `👤 *Cliente:* ${customerData.name}\n` +
                        `📱 *WhatsApp:* ${customerData.phone}\n` +
                        `📦 *Tipo:* ${orderTypeBR}\n` +
                        `📍 *Endereço:* ${customerData.address}\n` +
                        `💳 *Pagamento:* ${paymentBR}\n` +
                        `💰 *Total:* R$ ${total.toFixed(2).replace('.', ',')}\n\n` +
                        `🛒 *Itens:*\n` +
                        cart.map((i: any) => `- ${i.quantity || 1}x ${i.name} (R$ ${Number(i.price).toFixed(2).replace('.', ',')})`).join('\n');

    const sendToEvolution = async (targetNumber: string, isMedia: boolean = false) => {
      // 👇 REGEX E TRATAMENTO INTELIGENTE DE NÚMERO 👇
      let numeroLimpo = targetNumber.replace(/\D/g, ''); // Tira tudo que não é número
      
      // Se a pessoa digitou o 55, tiramos temporariamente para analisar o DDD e o Nono dígito
      if (numeroLimpo.startsWith('55')) {
        numeroLimpo = numeroLimpo.substring(2);
      }
      
      // Se o número tiver 10 dígitos (Ex: 98 84800522), adicionamos o 9 depois do DDD
      if (numeroLimpo.length === 10) {
        numeroLimpo = `${numeroLimpo.substring(0, 2)}9${numeroLimpo.substring(2)}`;
      }
      
      // Recoloca o 55 obrigatório do Brasil
      const numeroFinal = `55${numeroLimpo}`;

      console.log(`\n[SIAA] 📡 Tentando enviar WhatsApp para o número formatado: ${numeroFinal}`);

      let endpoint = `/message/sendText/${restaurant.evolutionInstance}`;
      let payload: any = { number: numeroFinal, text: messageText };

      if (isMedia && customerData.receiptUrl) {
        endpoint = `/message/sendMedia/${restaurant.evolutionInstance}`;
        const isPdf = customerData.receiptUrl.toLowerCase().endsWith('.pdf');
        payload = {
          number: numeroFinal,
          mediatype: isPdf ? 'document' : 'image',
          media: customerData.receiptUrl,
          caption: messageText,
          fileName: isPdf ? 'comprovante.pdf' : 'comprovante.jpg'
        };
      }

      try {
        const response = await fetch(`${evolutionBaseUrl}${endpoint}`, {
          method: 'POST',
          headers: {
            'apikey': restaurant.evolutionApiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        const data = await response.json();
        console.log(`[SIAA] ✅ Resposta da Hostinger para ${numeroFinal}:`, JSON.stringify(data));
        return data;
      } catch (error) {
        console.error(`[SIAA] ❌ Erro Crítico ao enviar para ${numeroFinal}:`, error);
      }
    };

    if (customerData.phone) await sendToEvolution(customerData.phone, true);
    if (restaurant.whatsapp) await sendToEvolution(restaurant.whatsapp, true);

    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Falha ao processar pedido" });
  }
});

app.get('/api/v1/siaa-admin/pdv/orders', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const orders = await prisma.order.findMany({
      where: { restaurantId: req.restaurantId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: 'Erro' });
  }
});

app.patch('/api/v1/siaa-admin/pdv/orders/:orderId/status', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.orderId as string } });
    
    if (!order || order.restaurantId !== req.restaurantId) return res.status(403).json({ error: 'Negado' });
    
    const updated = await prisma.order.update({
      where: { id: req.params.orderId as string },
      data: { status: req.body.status },
      include: { items: true },
    });
    
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
    // 👇 Adicionado "as string"
    const product = await prisma.product.findUnique({ where: { id: req.params.productId as string } });
    if (!product || product.restaurantId !== req.restaurantId) return res.status(403).json({ error: "Negado" });
    // 👇 Adicionado "as string"
    res.json(await prisma.product.update({ where: { id: req.params.productId as string }, data: req.body }));
  } catch (error) {
    res.status(500).json({ error: "Erro" });
  }
});

app.delete('/api/v1/siaa-admin/products/:productId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    // 👇 Adicionado "as string"
    await prisma.product.delete({ where: { id: req.params.productId as string } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Erro" });
  }
});

app.listen(3001, () => console.log("🚀 LOGOS SIAA API Rodando na Oracle (Conectada à Hostinger)"));

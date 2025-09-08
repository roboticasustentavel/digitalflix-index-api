// server.js
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import { PrismaClient } from "./generated/prisma/index.js"; // ou @prisma/client

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "digitalflix";

// ------------------------- HEALTH ------------------------- //
app.get("/", (_req, res) => {
  res.send("API de Filmes rodando...");
});

// ------------------------- AUTH --------------------------- //
app.post("/register", async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ error: "Campos obrigatórios: name, email, password." });
    }

    const user = await prisma.user.create({
      data: { name, email, password, role: role ?? "user" },
    });

    res.status(201).json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    });
  } catch (err) {
    console.error("[POST /register] error:", err);
    if (String(err?.code) === "P2002") {
      return res.status(409).json({ error: "E-mail já cadastrado." });
    }
    res.status(500).json({ error: "Erro ao registrar usuário." });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res
        .status(400)
        .json({ error: "Campos obrigatórios: email, password." });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.password !== password) {
      return res.status(401).json({ error: "Credenciais inválidas." });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.status(200).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("[POST /login] error:", err);
    res.status(500).json({ error: "Erro ao efetuar login." });
  }
});

// ------------------------- MOVIES ------------------------- //

// util helpers
const toBool = (v) =>
  v !== undefined
    ? typeof v === "string"
      ? v.toLowerCase() === "true"
      : Boolean(v)
    : undefined;

const toNum = (v) => {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
};

// GET /movies — SOMENTE aggregateRaw (resiliente a nulos/inconsistências)
app.get("/movies", async (req, res) => {
  try {
    const {
      search,
      page = "1",
      pageSize = "10",
      featured,
      minRating,
      maxRating,
      year,
    } = req.query;

    const currentPage = Math.max(1, Number(page) || 1);
    const take = Math.max(1, Math.min(100, Number(pageSize) || 10));
    const skip = (currentPage - 1) * take;

    const hasSearch = typeof search === "string" && search.trim() !== "";
    const fFeatured = toBool(featured);
    const fMin = toNum(minRating);
    const fMax = toNum(maxRating);
    const fYear = toNum(year);

    // $match dinâmico
    const match = { $and: [] };

    if (hasSearch) {
      const term = String(search).trim();
      match.$and.push({
        $or: [
          { title: { $regex: term, $options: "i" } },
          { genre: { $regex: term, $options: "i" } },
          { description: { $regex: term, $options: "i" } },
        ],
      });
    }

    if (fFeatured !== undefined) match.$and.push({ featured: fFeatured });
    if (fMin !== undefined) match.$and.push({ rating: { $gte: fMin } });
    if (fMax !== undefined) match.$and.push({ rating: { $lte: fMax } });
    if (fYear !== undefined) match.$and.push({ year: fYear });

    if (match.$and.length === 0) delete match.$and; // evita $and: []

    // Pipeline: match → sort (robusto) → facet (items + total com paginação)
    const pipeline = [
      ...(match ? [{ $match: match }] : []),
      { $sort: { year: -1, _id: -1 } }, // robusto: _id sempre existe; year ajuda
      {
        $facet: {
          items: [
            { $skip: skip },
            { $limit: take },
            {
              // normaliza campos para evitar null/undefined no frontend
              $project: {
                id: { $toString: "$_id" },
                title: { $ifNull: ["$title", "Sem título"] },
                genre: { $ifNull: ["$genre", ""] },
                rating: {
                  $cond: [
                    {
                      $and: [
                        { $ne: ["$rating", null] },
                        { $gte: ["$rating", 0] },
                      ],
                    },
                    "$rating",
                    0,
                  ],
                },
                image: { $ifNull: ["$image", ""] },
                featured: {
                  $cond: [{ $eq: ["$featured", true] }, true, false],
                },
                description: { $ifNull: ["$description", ""] },
                year: {
                  $cond: [
                    {
                      $and: [{ $ne: ["$year", null] }, { $gte: ["$year", 0] }],
                    },
                    "$year",
                    null,
                  ],
                },
                trailerUrl: { $ifNull: ["$trailerUrl", ""] },
              },
            },
          ],
          totalCount: [{ $count: "total" }],
        },
      },
      {
        $project: {
          items: 1,
          total: {
            $cond: [
              { $gt: [{ $size: "$totalCount" }, 0] },
              { $arrayElemAt: ["$totalCount.total", 0] },
              0,
            ],
          },
        },
      },
    ];

    const aggRes = await prisma.movies.aggregateRaw({ pipeline });
    const items = aggRes?.items ?? [];
    const total = Number(aggRes?.total ?? 0);

    return res.json({
      page: currentPage,
      pageSize: take,
      total,
      totalPages: Math.ceil(total / take),
      items,
    });
  } catch (err) {
    console.error("GET /movies error:", err);
    res.status(500).json({ error: "Erro ao listar filmes." });
  }
});

// GET /movies/:id — findRaw para tolerar documentos “inconsistentes”
app.get("/movies/:id", async (req, res) => {
  try {
    const id = String(req.params.id);
    // Extended JSON para ObjectId
    const docs = await prisma.movies.findRaw({
      filter: { _id: { $oid: id } },
      options: { limit: 1 },
    });

    const movie = Array.isArray(docs) ? docs[0] : null;
    if (!movie) return res.status(404).json({ error: "Filme não encontrado." });

    // normaliza campos básicos
    const normalized = {
      id: id,
      title: movie.title ?? "Sem título",
      genre: movie.genre ?? "",
      rating: typeof movie.rating === "number" ? movie.rating : 0,
      image: movie.image ?? "",
      featured: Boolean(movie.featured),
      description: movie.description ?? "",
      year: typeof movie.year === "number" ? movie.year : null,
      trailerUrl: movie.trailerUrl ?? "",
    };

    res.json(normalized);
  } catch (err) {
    console.error("[GET /movies/:id] error:", err);
    res.status(400).json({ error: "ID inválido." });
  }
});

// POST /movies — normaliza tipos; seta createdAt/updatedAt se existirem no schema
app.post("/movies", async (req, res) => {
  try {
    const {
      title,
      genre,
      rating,
      image,
      featured = false,
      description,
      year,
      trailerUrl,
    } = req.body;

    if (!title || typeof title !== "string")
      return res.status(400).json({ error: "title é obrigatório (string)." });
    if (!genre || typeof genre !== "string")
      return res.status(400).json({ error: "genre é obrigatório (string)." });

    const nRating = toNum(rating);
    if (nRating === undefined)
      return res.status(400).json({ error: "rating é obrigatório (number)." });

    if (!image || typeof image !== "string")
      return res
        .status(400)
        .json({ error: "image é obrigatório (string URL)." });

    if (!description || typeof description !== "string")
      return res
        .status(400)
        .json({ error: "description é obrigatório (string)." });

    const nYear = toNum(year);
    if (nYear === undefined)
      return res.status(400).json({ error: "year é obrigatório (number)." });

    if (!trailerUrl || typeof trailerUrl !== "string")
      return res
        .status(400)
        .json({ error: "trailerUrl é obrigatório (string URL)." });

    // Se o schema tiver createdAt/updatedAt, esses campos serão aceitos; caso não tenha, o Prisma ignora
    const created = await prisma.movies.create({
      data: {
        title: String(title),
        genre: String(genre),
        rating: Math.round(Number(nRating)), // Int no schema atual
        image: String(image),
        featured: !!featured,
        description: String(description),
        year: Math.round(Number(nYear)),
        trailerUrl: String(trailerUrl),
        createdAt: new Date(), // opcional se existir no schema
        updatedAt: new Date(), // opcional se existir no schema
      },
    });

    res.status(201).json(created);
  } catch (err) {
    console.error("[POST /movies] error:", err);
    res.status(500).json({ error: "Erro ao criar filme." });
  }
});

// PUT /movies/:id
app.put("/movies/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      genre,
      rating,
      image,
      featured,
      description,
      year,
      trailerUrl,
    } = req.body;

    const data = {};
    if (title !== undefined) data.title = String(title);
    if (genre !== undefined) data.genre = String(genre);
    if (rating !== undefined) data.rating = Math.round(Number(rating));
    if (image !== undefined) data.image = String(image);
    if (featured !== undefined) data.featured = !!featured;
    if (description !== undefined) data.description = String(description);
    if (year !== undefined) data.year = Math.round(Number(year));
    if (trailerUrl !== undefined) data.trailerUrl = String(trailerUrl);
    data.updatedAt = new Date(); // se existir no schema, é setado

    if (Object.keys(data).length === 1 && "updatedAt" in data) {
      return res.status(400).json({ error: "Nenhum campo para atualizar." });
    }

    const updated = await prisma.movies.update({
      where: { id },
      data,
    });

    res.json(updated);
  } catch (err) {
    console.error("[PUT /movies/:id] error:", err);
    if (String(err?.code) === "P2025") {
      return res.status(404).json({ error: "Filme não encontrado." });
    }
    res
      .status(400)
      .json({ error: "Erro ao atualizar filme (verifique o ID e os campos)." });
  }
});

// DELETE /movies/:id
app.delete("/movies/:id", async (req, res) => {
  try {
    const deleted = await prisma.movies.delete({
      where: { id: req.params.id },
    });
    res.json({ message: "Filme removido com sucesso.", id: deleted.id });
  } catch (err) {
    console.error("[DELETE /movies/:id] error:", err);
    if (String(err?.code) === "P2025") {
      return res.status(404).json({ error: "Filme não encontrado." });
    }
    res.status(400).json({ error: "Erro ao remover filme (ID inválido?)." });
  }
});

// ------------------------- START ------------------------- //
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor ouvindo em http://localhost:${PORT}`);
});

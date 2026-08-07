'use strict'
// Frases usadas pelos maturadores (chips e Wuzapi) pra simular conversa
// humana. No início da sessão o sorteio favorece saudações curtas; conforme
// mais mensagens vão sendo trocadas, a chance de sair uma frase mais longa
// sobe — mas nunca chega a 100%, então curtas continuam podendo aparecer no
// meio da maturação também (uma conversa real intercala os dois).

const short = [
  'Oi! 👋', 'Tudo bem?', 'Boa tarde!', 'Oi tudo bem?', 'Olá! 😊', 'E aí!',
  'Boa noite!', 'Como vai?', 'Tudo certo?', 'Oi!', 'Olá!', 'E aí, tudo na paz?',
  'Bom dia! ☀️', 'Oii', 'Fala!', 'Salve!', 'E aí, beleza?', 'Tudo tranquilo?',
  'Oi, sumido(a)! 😄', 'Como você tá?', 'Opa, tudo bem?', 'Ei, tudo certo por aí?',
  'Bom dia, tudo bem?', 'Oi oi', 'E aí, novidades?', 'Oi, tudo joia?',
  'Boa tarde, tudo certo?', 'Eae!', 'Oi, td bem?', 'Bom te ver por aqui 😊',
]

const long = [
  'Vixi, hoje o dia tá corrido demais, mal deu tempo de almoçar direito 😅',
  'Acabei de ver uma notícia bem interessante, depois te conto com calma',
  'Tô pensando em fazer uma viagem esse mês, ainda não decidi pra onde ir',
  'Nossa, faz tempo que a gente não se fala direito, como andam as coisas?',
  'Hoje choveu bastante aqui, o trânsito ficou um caos total',
  'Assisti um filme ontem que gostei bastante, depois te indico',
  'Tô tentando organizar minha semana, tá difícil de encaixar tudo 😂',
  'Semana que vem preciso resolver umas coisas, mas por enquanto tá tranquilo',
  'Você viu aquele lance que rolou hoje? Foi bem inesperado',
  'Ando meio corrido ultimamente, mas de boa, levando o dia',
  'Hoje acordei mais cedo que o normal, aproveitei pra adiantar umas coisas',
  'Tô com vontade de comer alguma coisa diferente hoje, ainda não decidi o quê',
  'Passei o dia resolvendo umas pendências, agora finalmente sobrou um tempinho',
  'Tava pensando aqui, será que a gente devia marcar algo em breve?',
  'O dia tá corrido, mas nada que não dê pra levar numa boa',
  'Fiquei sabendo de uma novidade hoje, depois te conto os detalhes com calma',
  'Tô devendo umas respostas por aqui, desculpa a demora rs',
  'Hoje foi um dia daqueles corridos, mas valeu a pena no final',
  'Tava pensando em mudar um pouco a rotina, ver se rende mais o dia',
  'Semana corrida, mas já tá quase acabando, ainda bem 😅',
  'Acabei de resolver uma coisa que tava enrolando faz dias, que alívio',
  'Hoje o dia começou meio devagar, mas foi engrenando aos poucos',
]

// Depois de RAMP_MESSAGES trocadas na sessão, a chance de frase longa chega
// no teto (MAX_LONG_CHANCE) e para de subir.
const RAMP_MESSAGES = 40
const MAX_LONG_CHANCE = 0.6

function pick(msgCount = 0) {
  const longChance = Math.min(MAX_LONG_CHANCE, (msgCount / RAMP_MESSAGES) * MAX_LONG_CHANCE)
  const pool = Math.random() < longChance ? long : short
  return pool[Math.floor(Math.random() * pool.length)]
}

function pickShort() {
  return short[Math.floor(Math.random() * short.length)]
}

module.exports = { short, long, pick, pickShort }

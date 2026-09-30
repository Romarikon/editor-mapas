// Roles de tiles para la lógica del generador: cada rol agrupa palabras que se buscan dentro de las etiquetas.
// rol -> palabras (se busca cada palabra dentro de las etiquetas)
const ROLES = {
  puerta: ['puerta', 'portal', 'trampilla', 'arco'],
  ventana: ['ventana'],
  mueble: ['mueble', 'silla', 'mesa', 'cama', 'estantería', 'armario', 'sofá', 'taburete', 'banco', 'escritorio', 'cómoda', 'mostrador', 'espejo', 'reloj', 'alfombra', 'cuadro', 'tapiz'],
  asiento: ['silla', 'taburete', 'banco', 'sofá', 'mecedora'],
  mesa: ['mesa', 'escritorio', 'mostrador'],
  luz: ['antorcha', 'farol', 'farola', 'vela', 'lámpara', 'candelabro', 'luz'],
  fuego: ['fuego', 'brasas', 'hoguera', 'lava'],
  vegetacion: ['árbol', 'arbusto', 'planta', 'flor', 'hierba', 'bambú', 'palmera', 'juncos', 'trigo', 'seta', 'musgo', 'enredadera', 'trébol', 'nenúfar', 'hoja'],
  arbol: ['árbol', 'palmera', 'abeto'],
  roca: ['roca', 'piedra', 'rocas', 'guijarros', 'estalagmita', 'cristal'],
  agua: ['agua', 'charco', 'orilla', 'nenúfar', 'hielo'],
  tumba: ['tumba', 'lápida', 'huesos', 'calavera', 'cráneo', 'horca', 'colmillo'],
  contenedor: ['barril', 'caja', 'cajón', 'cofre', 'saco', 'jarrón', 'vasija', 'ánfora', 'cubo', 'tina', 'frasco', 'botella', 'maceta'],
  estructura: ['muro', 'columna', 'poste', 'valla', 'empalizada', 'verja', 'obelisco', 'tótem', 'estatua', 'pilar', 'ruina', 'tejado', 'esquina'],
  suelo: ['parche', 'borde', 'losas', 'baldosas', 'camino', 'tablones', 'parqué', 'tarima', 'grava', 'tierra', 'arena', 'paja', 'esterilla', 'adoquines', 'plataforma'],
  efecto: ['efecto', 'sombra', 'luz', 'destello', 'humo', 'niebla', 'lluvia', 'burbujas', 'rayo', 'vacío'],
  oscuro: ['oscuro', 'muerto', 'huesos', 'calavera', 'tumba', 'lápida', 'telaraña', 'sangre', 'horca', 'araña', 'retorcido', 'cadenas'],
};
const roles = tags => Object.entries(ROLES).filter(([, words]) => tags.some(t => words.some(w => t.includes(w)))).map(([r]) => r);
module.exports = { ROLES, roles };

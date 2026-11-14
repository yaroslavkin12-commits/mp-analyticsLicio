// Главный администратор — только учётная запись владельца.
const OWNER_LOGIN = 'evgeniy';
const isOwner = req => req.user?.login === OWNER_LOGIN && req.user?.role === 'owner';
const isAdmin = req => isOwner(req) || req.user?.role === 'admin';
const isProtected = user => user?.login === OWNER_LOGIN || user?.role === 'owner';
function userFields(req) {
  return isOwner(req)
    ? 'id, login, name, role, disabled, created_at, last_login'
    : 'id, login, name, role, disabled';
}
module.exports = { OWNER_LOGIN, isOwner, isAdmin, isProtected, userFields };

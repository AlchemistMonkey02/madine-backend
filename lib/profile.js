// Shapes a user document for the browser. publicProfile is what other people
// see; selfProfile adds the private fields only the owner gets back.
const PREFERENCE_OPTIONS = ['Mornings', 'Afternoons', 'Evenings', 'Late nights', 'Weekends'];

const avatarUrl = (u) => (u.avatarVersion ? `/api/users/${u._id}/avatar?v=${u.avatarVersion}` : null);

function publicProfile(u) {
  const name = u.name || '';
  const interests = u.interests || [];
  const preference = u.preference || [];
  return {
    id: String(u._id),
    name,
    initial: (name.charAt(0) || '?').toUpperCase(),
    role: u.role || '',
    tag: interests[0] || '',
    bio: u.bio || '',
    interests,
    favoriteCafes: u.favoriteCafes || [],
    preference,
    generalPreference: preference.length ? `Usually ${preference.map((p) => p.toLowerCase()).join(', ')}` : '',
    avatar: avatarUrl(u),
  };
}

function selfProfile(u) {
  return {
    ...publicProfile(u),
    email: u.email,
    profileComplete: !!u.name,
    saved: u.saved || [],
    createdAt: u.createdAt,
  };
}

module.exports = { PREFERENCE_OPTIONS, publicProfile, selfProfile };

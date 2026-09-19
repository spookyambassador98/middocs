export interface AuthUser {
  id: string;
  email: string;
  name: string;
  color: string;
}

export interface JwtPayload {
  sub: string;
  email: string;
  name: string;
  color: string;
}

export interface DocumentSummary {
  id: string;
  title: string;
  ownerId: string;
  ownerName: string;
  isOwner: boolean;
  updatedAt: string;
  createdAt: string;
}
